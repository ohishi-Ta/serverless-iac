import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { BedrockAgentRuntimeClient, RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";

// AWSクライアントの初期化
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);
const bedrockRuntime = new BedrockRuntimeClient({ region: process.env.BEDROCK_AWS_REGION });
const bedrockAgentRuntime = new BedrockAgentRuntimeClient({ region: process.env.BEDROCK_AWS_REGION });

// 環境変数
const CHAT_TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;
const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID;
const BEDROCK_AWS_REGION = process.env.BEDROCK_AWS_REGION;

// モデルマッピング
const MODEL_MAPPING = {
    'nova-lite': 'amazon.nova-lite-v1:0',
    'nova-pro': 'amazon.nova-pro-v1:0',
    'claude-3-7-sonnet': 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
    'claude-sonnet-4': 'us.anthropic.claude-sonnet-4-20250514-v1:0'
};

// JWTトークンからユーザーIDを抽出
function extractUserIdFromToken(token) {
    try {
        if (token.startsWith('Bearer ')) {
            token = token.substring(7);
        }
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        
        const payload = parts[1];
        const decoded = Buffer.from(payload, 'base64').toString('utf-8');
        const claims = JSON.parse(decoded);
        
        if (claims.exp && claims.exp < Date.now() / 1000) {
            console.warn('Token expired');
            return null;
        }
        
        return claims.sub;
    } catch (error) {
        console.error('Token decode failed:', error);
        return null;
    }
}

// SSEイベントのフォーマット
function formatSSEEvent(eventType, data) {
    if (eventType === 'message') {
        const jsonData = JSON.stringify({ type: 'message', data: data });
        return `data: ${jsonData}\n\n`;
    } else {
        const jsonData = JSON.stringify(data);
        return `event: ${eventType}\ndata: ${jsonData}\n\n`;
    }
}

// エラーレスポンスを送信
function sendErrorResponse(responseStream, message) {
    responseStream.write(formatSSEEvent('error', message));
    responseStream.write(formatSSEEvent('end', 'Stream ended'));
    responseStream.end();
}

// ★ 履歴機能のための関数群を追加

// DynamoDB履歴をClaude Messages形式に変換
function convertDynamoToClaudeMessages(dynamoMessages) {
    return dynamoMessages.map(msg => {
        const content = [];
        
        // テキストコンテンツを追加
        if (msg.content) {
            content.push({ type: 'text', text: msg.content });
        }
        
        // 添付ファイル処理（ユーザーメッセージのみ）
        if (msg.role === 'user' && msg.attachment?.data) {
            if (msg.attachment.fileType?.startsWith('image/')) {
                content.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: msg.attachment.fileType,
                        data: msg.attachment.data
                    }
                });
            } else if (msg.attachment.fileType === 'application/pdf') {
                content.push({
                    type: 'document',
                    source: {
                        type: 'base64',
                        media_type: msg.attachment.fileType,
                        data: msg.attachment.data
                    }
                });
            }
        }
        
        return {
            role: msg.role,
            content: content
        };
    });
}

// 履歴制限関数
function limitHistoryMessages(messages, maxMessages = 10) {
    if (messages.length <= maxMessages) {
        return messages;
    }
    
    const limitedMessages = messages.slice(-maxMessages);
    
    // 最初のメッセージがassistantの場合、その前のuserメッセージも含める
    if (limitedMessages[0]?.role === 'assistant' && messages.length > maxMessages) {
        const prevUserIndex = messages.findIndex(m => m.id === limitedMessages[0].id) - 1;
        if (prevUserIndex >= 0 && messages[prevUserIndex]?.role === 'user') {
            limitedMessages.unshift(messages[prevUserIndex]);
        }
    }
    
    return limitedMessages;
}

// 履歴取得関数
async function getChatHistory(chatId, userId) {
    if (!chatId) return [];
    
    try {
        const getCommand = new GetCommand({
            TableName: CHAT_TABLE_NAME,
            Key: { userId }
        });
        const dbResponse = await dynamodb.send(getCommand);
        const allChats = dbResponse.Item?.chats || [];
        
        const currentChat = allChats.find(chat => chat.id === chatId);
        if (currentChat?.messages) {
            const limitedHistory = limitHistoryMessages(currentChat.messages, 10);
            return convertDynamoToClaudeMessages(limitedHistory);
        }
    } catch (error) {
        console.error('[ERROR] 履歴取得エラー:', error);
    }
    
    return [];
}

// Lambda Response Streaming ハンドラー
export const handler = awslambda.streamifyResponse(async (event, responseStream, context) => {
    console.log('[DEBUG] Request received');
    
    responseStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 200,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        }
    });
    
    try {
        const httpMethod = event.requestContext?.http?.method || event.httpMethod;
        
        if (httpMethod === 'OPTIONS') {
            responseStream.end();
            return;
        }
        
        if (httpMethod === 'GET') {
            responseStream.write('<h1>Lambda Function with Response Streaming is working!</h1>');
            responseStream.end();
            return;
        }
        
        if (httpMethod === 'POST') {
            try {
                // 認証処理
                const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
                const userId = extractUserIdFromToken(authHeader);
                
                if (!userId) {
                    console.log('[DEBUG] 認証失敗');
                    sendErrorResponse(responseStream, 'Unauthorized');
                    return;
                }
                
                // リクエストボディの解析
                let body = {};
                if (event.body) {
                    try {
                        body = event.isBase64Encoded 
                            ? JSON.parse(Buffer.from(event.body, 'base64').toString('utf-8'))
                            : JSON.parse(event.body);
                    } catch (parseError) {
                        console.error('[ERROR] JSON解析エラー:', parseError);
                        sendErrorResponse(responseStream, 'Invalid JSON in request body');
                        return;
                    }
                }
                
                const userPrompt = body.user_prompt || '';
                const chatId = body.chat_id;
                let mode = body.mode || 'knowledge_base';
                let modelKey = body.model || 'nova-lite';
                const attachment = body.attachment;
                const userMessageId = body.user_message_id;
                const assistantMessageId = body.assistant_message_id;
                
                // 必須パラメータのチェック
                if (!userMessageId || !assistantMessageId) {
                    console.error('[ERROR] メッセージIDが不足');
                    sendErrorResponse(responseStream, 'Message IDs are required');
                    return;
                }
                
                if (!userPrompt && !attachment) {
                    console.log('[DEBUG] プロンプトと添付ファイルが両方なし');
                    sendErrorResponse(responseStream, 'user_prompt or attachment is required');
                    return;
                }
                
                // ★ 履歴取得（両モード共通）
                const historyMessages = await getChatHistory(chatId, userId);
                console.log(`[DEBUG] 取得した履歴メッセージ数: ${historyMessages.length}`);
                
                // 添付ファイル処理
                let processedAttachment = null;
                if (attachment) {
                    try {
                        processedAttachment = {
                            type: attachment.source.type,
                            source: {
                                type: 'base64',
                                media_type: attachment.source.media_type,
                                data: attachment.source.data
                            }
                        };
                        
                        mode = 'general';
                        
                    } catch (attachmentError) {
                        console.error('[ERROR] 添付ファイル処理エラー:', attachmentError);
                        sendErrorResponse(responseStream, `添付ファイル処理エラー: ${attachmentError.message}`);
                        return;
                    }
                }
                
                const modelId = MODEL_MAPPING[modelKey];
                if (!modelId) {
                    console.error('[ERROR] サポートされていないモデル:', modelKey);
                    sendErrorResponse(responseStream, `サポートされていないモデル: ${modelKey}`);
                    return;
                }
                
                // プロンプト構築
                let finalMessages = []; // ★ userMessageContent から finalMessages に変更
                const dbSavePrompt = userPrompt || '添付されたファイルについて説明してください。';

                if (mode === 'knowledge_base') {
                    try {
                        const retrieveCommand = new RetrieveCommand({
                            knowledgeBaseId: KNOWLEDGE_BASE_ID,
                            retrievalQuery: { text: userPrompt },
                            retrievalConfiguration: {
                                vectorSearchConfiguration: {
                                    numberOfResults: 10,
                                    overrideSearchType: 'HYBRID'
                                }
                            }
                        });
                        
                        const retrieveResponse = await bedrockAgentRuntime.send(retrieveCommand);
                        const retrievedChunks = retrieveResponse.retrievalResults || [];
                        
                        let contextString = '';
                        if (retrievedChunks.length > 0) {
                            contextString = 'あなたは優秀な社内情報検索アシスタントです。以下の参考資料を使用してユーザーの質問に正確に回答してください。\n\n';
                            contextString += '## 回答ルール\n';
                            contextString += '1. **情報が見つかった場合**: 参考資料から正確な情報を抽出し、簡潔に回答する\n';
                            contextString += '2. **情報が見つからない場合**: 「申し訳ありませんが、該当する情報が見つかりませんでした」と回答する\n';
                            contextString += '<参考情報>\n';
                            
                            retrievedChunks.forEach((chunk, i) => {
                                const cleanText = chunk.content.text
                                .replace(/\t+/g, ' ')           // タブを空白に
                                .replace(/\n+/g, ' ')           // 改行を空白に
                                .replace(/\s+/g, ' ')           // 連続空白を1つに
                                .trim();
                                contextString += `<資料${i+1}>\n${cleanText}\n</資料${i+1}>\n`;
                            });
                            
                            contextString += '</参考情報>\n\n';
                        }
                        
                        const bedrockPrompt = `${contextString}質問: ${userPrompt}`;
                        
                        // ★ Knowledge BaseモードでもDynamoDB履歴を使用
                        finalMessages = [
                            ...historyMessages,
                            { role: 'user', content: [{ type: 'text', text: bedrockPrompt }] }
                        ];
                        
                    } catch (error) {
                        console.error('[ERROR] Knowledge base error:', error);
                        responseStream.write(formatSSEEvent('message', 'Knowledge base unavailable, switching to general mode...\n\n'));
                        mode = 'general';
                    }
                }
                
                if (mode === 'general') {
                    // generalモードの場合
                    let userMessageContent = [];
                    
                    if (processedAttachment) {
                        userMessageContent.push(processedAttachment);
                    }
                    
                    if (userPrompt) {
                        userMessageContent.push({ type: 'text', text: userPrompt });
                    }
                    
                    if (!userPrompt && processedAttachment) {
                        userMessageContent.push({ type: 'text', text: '添付されたファイルについて説明してください。' });
                    }
                    
                    // ★ Generalモードでも履歴を含める
                    finalMessages = [
                        ...historyMessages,
                        { role: 'user', content: userMessageContent }
                    ];
                }
                
                if (finalMessages.length === 0) {
                    console.error('[ERROR] メッセージコンテンツが空');
                    sendErrorResponse(responseStream, 'メッセージコンテンツが空です');
                    return;
                }
                
                console.log(`[DEBUG] 送信メッセージ数: ${finalMessages.length}`);
                
                // Bedrockリクエストボディの構築
                let requestBody;
                if (modelKey.startsWith('claude')) {
                    requestBody = {
                        anthropic_version: 'bedrock-2023-05-31',
                        max_tokens: 4096,
                        messages: finalMessages // ★ 履歴込みのメッセージ配列
                    };
                } else {
                    // ★ Nova系モデルでも履歴対応

                    const novaMessages = finalMessages.map(msg => ({
                        role: msg.role,
                        content: msg.content.map(item => {
                            if (item.type === 'text') {
                                return { text: item.text };
                            }
                            if (item.type === 'image') {
                                return {
                                    image: {
                                        format: item.source.media_type.split('/')[1], // "image/jpeg" → "jpeg"
                                        source: {
                                            bytes: item.source.data
                                        }
                                    }
                                };
                            }
                            if (item.type === 'document') {
                                return {
                                    document: {
                                        format: item.source.media_type.split('/')[1], // "application/pdf" → "pdf"
                                        name: "DocumentPDFmessages",
                                        source: {
                                            bytes: item.source.data
                                        }
                                    }
                                };
                            }
                            return null;
                        }).filter(Boolean)
                    }));


                    requestBody = {
                        messages: novaMessages,
                        inferenceConfig: { maxTokens: 4096 }
                    };
                }
                
                // Bedrockストリーミング呼び出し
                const invokeCommand = new InvokeModelWithResponseStreamCommand({
                    modelId: modelId,
                    body: JSON.stringify(requestBody)
                });
                
                const response = await bedrockRuntime.send(invokeCommand);
                let fullResponseText = '';
                
                // リアルタイムストリーミング処理
                try {
                    for await (const chunk of response.body) {
                        const chunkData = JSON.parse(new TextDecoder().decode(chunk.chunk.bytes));
                        let textDelta = '';
                        
                        if (modelKey.startsWith('claude')) {
                            if (chunkData.type === 'content_block_delta') {
                                textDelta = chunkData.delta.text;
                            }
                        } else {
                            if (chunkData.contentBlockDelta?.delta?.text) {
                                textDelta = chunkData.contentBlockDelta.delta.text;
                            }
                        }
                        
                        if (textDelta) {
                            fullResponseText += textDelta;
                            responseStream.write(formatSSEEvent('message', textDelta));
                        }
                    }
                } catch (streamError) {
                    console.error('[ERROR] Bedrock streaming error:', streamError);
                    responseStream.write(formatSSEEvent('error', 'Bedrock streaming failed'));
                    responseStream.write(formatSSEEvent('end', 'Stream ended due to error'));
                    responseStream.end();
                    return;
                }
                
                // DynamoDB保存処理
                try {
                    const getCommand = new GetCommand({
                        TableName: CHAT_TABLE_NAME,
                        Key: { userId }
                    });
                    const dbResponse = await dynamodb.send(getCommand);
                    const allChats = dbResponse.Item?.chats || [];
                    
                    // メッセージ作成
                    const newMessageUser = {
                        id: userMessageId,
                        role: 'user',
                        content: dbSavePrompt
                    };
                    
                    // 添付ファイル情報の保存
                    if (processedAttachment && body.attachment) {
                        if (body.attachment.s3Key) {
                            newMessageUser.attachment = {
                                fileName: body.attachment.fileName || 'unknown_file',
                                fileType: processedAttachment.source.media_type,
                                size: body.attachment.size || 0,
                                s3Key: body.attachment.s3Key,
                                isS3Upload: true
                            };
                        } else {
                            newMessageUser.attachment = {
                                fileName: body.attachment.fileName || 'unknown_file',
                                fileType: processedAttachment.source.media_type,
                                size: body.attachment.size || 0,
                                isS3Upload: false,
                                note: '履歴では画像を表示できません（S3キーがありません）'
                            };
                        }
                    }
                    
                    const newMessageAssistant = {
                        id: assistantMessageId,
                        role: 'assistant',
                        content: fullResponseText,
                        mode: mode,
                        model: modelKey
                    };
                    
                    const isNewChat = !chatId;
                    
                    if (!isNewChat) {
                        // 既存チャットの場合
                        const chatIndex = allChats.findIndex(chat => chat.id === chatId);
                        if (chatIndex !== -1) {
                            const existingMessages = allChats[chatIndex].messages || [];
                            const userMessageExists = existingMessages.some(msg => msg.id === userMessageId);
                            const assistantMessageExists = existingMessages.some(msg => msg.id === assistantMessageId);
                            
                            if (!userMessageExists && !assistantMessageExists) {
                                allChats[chatIndex].messages.push(newMessageUser, newMessageAssistant);
                                console.log('[DEBUG] 既存チャットにメッセージを追加');
                            }
                        }
                    } else {
                        // 新規チャットの場合
                        const targetChatId = userMessageId;
                        const chatTitle = dbSavePrompt.substring(0, 30);
                        
                        const newChatThread = {
                            id: targetChatId,
                            title: chatTitle + (chatTitle.length >= 30 ? '...' : ''),
                            messages: [newMessageUser, newMessageAssistant]
                        };
                        
                        const existingChatIndex = allChats.findIndex(chat => chat.id === targetChatId);
                        if (existingChatIndex === -1) {
                            allChats.unshift(newChatThread);
                            console.log('[DEBUG] 新規チャットを作成');
                            responseStream.write(formatSSEEvent('newChat', newChatThread));
                        }
                    }
                    
                    // DynamoDBに保存
                    const putCommand = new PutCommand({
                        TableName: CHAT_TABLE_NAME,
                        Item: { userId, chats: allChats }
                    });
                    
                    await dynamodb.send(putCommand);
                    
                } catch (error) {
                    console.error('[ERROR] DynamoDB保存エラー:', error);
                    responseStream.write(formatSSEEvent('warning', 'チャット履歴の保存に失敗しましたが、会話は続行できます'));
                }
                
                responseStream.write(formatSSEEvent('end', 'Stream ended'));
                
            } catch (error) {
                console.error('[ERROR] Processing error:', error);
                responseStream.write(formatSSEEvent('error', error.message));
                responseStream.write(formatSSEEvent('end', 'Stream ended due to error'));
            }
            
            responseStream.end();
        }
        
    } catch (error) {
        console.error('[ERROR] Fatal error:', error);
        responseStream.write(formatSSEEvent('error', error.message));
        responseStream.write(formatSSEEvent('end', 'Stream ended due to fatal error'));
        responseStream.end();
    }
});