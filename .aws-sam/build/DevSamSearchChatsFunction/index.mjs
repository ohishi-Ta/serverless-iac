import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const REGION_NAME = process.env.AWS_REGION;
const CHAT_TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;

const client = new DynamoDBClient({ region: REGION_NAME });
const dynamodb = DynamoDBDocumentClient.from(client);

/**
 * チャット検索を実行
 */
async function searchChats(userId, query, limit = 20, offset = 0) {
    try {
        console.log(`検索開始: userId=${userId}, query="${query}", limit=${limit}, offset=${offset}`);
        
        // DynamoDBからユーザーの全チャットデータを取得
        const command = new GetCommand({
            TableName: CHAT_TABLE_NAME,
            Key: { userId: userId }
        });
        
        const response = await dynamodb.send(command);
        const allChats = response.Item?.chats || [];
        
        console.log(`取得したチャット数: ${allChats.length}`);
        
        if (allChats.length === 0) {
            return { results: [], totalCount: 0 };
        }
        
        // 検索キーワードを正規化（大文字小文字無視、空白除去）
        const normalizedQuery = query.trim().toLowerCase();
        const searchTerms = normalizedQuery.split(/\s+/);
        
        console.log(`検索キーワード: ${searchTerms.join(', ')}`);
        
        const searchResults = [];
        
        for (const chat of allChats) {
            const chatId = chat.id || '';
            const title = (chat.title || '').toLowerCase();
            const messages = chat.messages || [];
            
            // タイトル検索
            const titleMatches = [];
            for (const term of searchTerms) {
                if (title.includes(term)) {
                    titleMatches.push(term);
                }
            }
            
            // メッセージ内容検索
            const contentMatches = [];
            const matchedContentSnippets = [];
            
            for (const message of messages) {
                const content = (message.content || '').toLowerCase();
                for (const term of searchTerms) {
                    if (content.includes(term)) {
                        contentMatches.push(term);
                        // マッチした部分の前後50文字を抽出
                        const matchIndex = content.indexOf(term);
                        const start = Math.max(0, matchIndex - 50);
                        const end = Math.min(content.length, matchIndex + term.length + 50);
                        const snippet = content.substring(start, end);
                        matchedContentSnippets.push(snippet);
                    }
                }
            }
            
            // マッチした場合は結果に追加
            if (titleMatches.length > 0 || contentMatches.length > 0) {
                // 関連度スコア計算（タイトルマッチを重視）
                const titleScore = titleMatches.length * 3;
                const contentScore = contentMatches.length * 1;
                const totalScore = titleScore + contentScore;
                
                // マッチタイプ決定
                const matchType = titleMatches.length > 0 ? 'title' : 'content';
                
                // マッチしたコンテンツの最初のスニペット
                const matchedContent = matchedContentSnippets.length > 0 
                    ? matchedContentSnippets[0] 
                    : title;
                
                searchResults.push({
                    chatId: chatId,
                    title: chat.title || '',
                    matchedContent: matchedContent,
                    matchType: matchType,
                    score: totalScore,
                    createdAt: chat.createdAt || '',
                    updatedAt: chat.updatedAt || ''
                });
            }
        }
        
        // スコア順でソート
        searchResults.sort((a, b) => b.score - a.score);
        
        console.log(`検索結果: ${searchResults.length}件`);
        
        // ページネーション適用
        const totalCount = searchResults.length;
        const paginatedResults = searchResults.slice(offset, offset + limit);
        
        return {
            results: paginatedResults,
            totalCount: totalCount,
            query: query,
            limit: limit,
            offset: offset
        };
        
    } catch (error) {
        console.error('検索エラー:', error);
        throw error;
    }
}

/**
 * HTTPメソッドを取得する関数
 */
function getHttpMethod(event) {
    return event.httpMethod || 
           event.requestContext?.httpMethod || 
           event.requestContext?.http?.method || 
           '';
}

/**
 * 検索Lambda関数のメインハンドラー
 */
export const handler = async (event, context) => {
    console.log('=== 検索Lambda関数実行開始 ===');
    console.log('受信イベント:', JSON.stringify(event, null, 2));
    
    // CORS headers
    const corsHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,OPTIONS'
    };
    
    try {
        // HTTPメソッド取得
        const httpMethod = getHttpMethod(event);
        console.log('HTTPメソッド:', httpMethod);
        
        // OPTIONSリクエスト（プリフライト）の処理
        if (httpMethod === 'OPTIONS') {
            console.log('プリフライトリクエストを処理');
            return {
                statusCode: 200,
                headers: corsHeaders,
                body: ''
            };
        }
        
        // GETリクエストのみ許可
        if (httpMethod !== 'GET') {
            console.error('許可されていないHTTPメソッド:', httpMethod);
            return {
                statusCode: 405,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Method not allowed' })
            };
        }
        
        // JWT認証からユーザーIDを取得
        let userId;
        try {
            userId = event.requestContext.authorizer.jwt.claims.sub;
            console.log('ユーザーID:', userId);
        } catch (error) {
            console.error('認証情報取得エラー:', error);
            console.log('requestContext:', JSON.stringify(event.requestContext, null, 2));
            return {
                statusCode: 401,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Authentication failed' })
            };
        }
        
        // クエリパラメータ取得
        const queryParams = event.queryStringParameters || {};
        console.log('クエリパラメータ:', queryParams);
        
        // 検索クエリ取得（必須）
        const query = (queryParams.q || '').trim();
        if (!query) {
            console.error('検索クエリが空です');
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Search query (q) is required' })
            };
        }
        
        // URLデコード
        const decodedQuery = decodeURIComponent(query);
        console.log('デコード後クエリ:', decodedQuery);
        
        // ページネーションパラメータ
        let limit, offset;
        try {
            limit = parseInt(queryParams.limit || '20');
            offset = parseInt(queryParams.offset || '0');
        } catch (error) {
            console.error('limitまたはoffsetの変換エラー:', error);
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Invalid limit or offset parameter' })
            };
        }
        
        // バリデーション
        if (limit > 100) {
            limit = 100;  // 最大100件に制限
        }
        if (offset < 0) {
            offset = 0;
        }
        
        console.log(`検索実行: query='${decodedQuery}', limit=${limit}, offset=${offset}`);
        
        // 検索実行
        const results = await searchChats(userId, decodedQuery, limit, offset);
        
        console.log(`検索完了: ${results.results.length}件の結果`);
        
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify(results)
        };
        
    } catch (error) {
        console.error('Lambda実行中にエラー発生:', error);
        console.error('スタックトレース:', error.stack);
        
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ 
                error: 'Internal server error',
                details: error.message
            })
        };
    }
};