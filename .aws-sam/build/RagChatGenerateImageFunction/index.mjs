import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// AWSクライアントの初期化
const bedrockRuntime = new BedrockRuntimeClient({ region: process.env.BEDROCK_GENIMAGE_AWS_REGION });
const s3Client = new S3Client({ region: process.env.AWS_REGION });

// 環境変数
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;
const BEDROCK_GENIMAGE_AWS_REGION = process.env.BEDROCK_GENIMAGE_AWS_REGION;

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

// 複数画像をS3にアップロード（シード情報付き）
async function uploadImagesToS3(images, userId, prompt) {
    if (!images || !Array.isArray(images) || images.length === 0) {
        console.error('[ERROR] uploadImagesToS3: 不正な画像配列:', images);
        throw new Error('画像配列が不正です');
    }
    
    console.log(`[DEBUG] S3アップロード開始: ${images.length}枚の画像`);
    
    const uploadPromises = images.map(async (imageData, index) => {
        try {
            if (!imageData || !imageData.base64Image || !imageData.seed) {
                console.error(`[ERROR] 画像${index + 1}のデータが不完全:`, {
                    hasBase64: !!imageData?.base64Image,
                    hasSeed: !!imageData?.seed
                });
                return null;
            }
            
            const imageBuffer = Buffer.from(imageData.base64Image, 'base64');
            const timestamp = Date.now();
            const sanitizedPrompt = prompt.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
            // 🎯 シード値をファイル名に含める
            const s3Key = `generated-images/${userId}/${timestamp}_${sanitizedPrompt}_seed${imageData.seed}.png`;
            
            const sanitizeForHeader = (str) => {
                return str
                    .replace(/[\r\n\t]/g, ' ')
                    .replace(/[^\x20-\x7E]/g, '')
                    .replace(/"/g, "'")
                    .trim()
                    .substring(0, 200);
            };
            
            const putCommand = new PutObjectCommand({
                Bucket: S3_BUCKET_NAME,
                Key: s3Key,
                Body: imageBuffer,
                ContentType: 'image/png',
                Metadata: {
                    'generated-by': 'nova-canvas',
                    'user-id': userId,
                    'prompt': sanitizeForHeader(prompt),
                    'image-index': (index + 1).toString(),
                    'seed': imageData.seed.toString(), // 🎯 シード値をメタデータに保存
                    'created-at': new Date().toISOString()
                }
            });
            
            await s3Client.send(putCommand);
            console.log(`[DEBUG] 画像${index + 1}をS3にアップロード完了: ${s3Key} (seed: ${imageData.seed})`);
            
            return s3Key;
        } catch (error) {
            console.error(`[ERROR] 画像${index + 1}のS3アップロードエラー:`, error);
            return null;
        }
    });
    
    const results = await Promise.all(uploadPromises);
    console.log(`[DEBUG] S3アップロード完了: ${results.filter(r => r !== null).length}/${images.length}枚成功`);
    return results;
}

// 🎯 個別画像生成関数
async function generateSingleImage(prompt, negativePrompt, width, height, seed) {
    const requestBody = {
        taskType: "TEXT_IMAGE",
        textToImageParams: {
            text: prompt,
            negativeText: negativePrompt || undefined,
        },
        imageGenerationConfig: {
            numberOfImages: 1,
            height: height,
            width: width,
            cfgScale: 8.0,
            seed: seed,
            quality: "standard"
        }
    };
    
    console.log(`[DEBUG] 個別画像生成 (seed: ${seed}):`, JSON.stringify(requestBody, null, 2));
    
    const invokeCommand = new InvokeModelCommand({
        modelId: 'amazon.nova-canvas-v1:0',
        body: JSON.stringify(requestBody),
        contentType: 'application/json',
        accept: 'application/json'
    });
    
    const response = await bedrockRuntime.send(invokeCommand);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    
    if (responseBody.error) {
        throw new Error(`Bedrock error (seed ${seed}): ${responseBody.error}`);
    }
    
    if (!responseBody.images || responseBody.images.length === 0) {
        throw new Error(`画像生成レスポンスが空です (seed ${seed})`);
    }
    
    const base64Image = responseBody.images[0];
    const imageBuffer = Buffer.from(base64Image, 'base64');
    
    console.log(`[DEBUG] 個別画像生成完了 (seed: ${seed}): ${imageBuffer.length} bytes`);
    
    return {
        base64Image: base64Image,
        imageBuffer: imageBuffer,
        seed: seed
    };
}

// 🎯 複数画像生成関数
async function generateImages(prompt, negativePrompt = '', width = 512, height = 512, seeds = [], numberOfImages = 1) {
    try {
        console.log(`[DEBUG] 複数画像生成開始: prompt="${prompt}", numberOfImages=${numberOfImages}, seeds=${JSON.stringify(seeds)}`);
        
        // シード配列の検証・生成
        let actualSeeds = [];
        if (seeds && Array.isArray(seeds) && seeds.length >= numberOfImages) {
            // フロントエンドから送信されたシード配列を使用
            actualSeeds = seeds.slice(0, numberOfImages);
            console.log(`[DEBUG] フロントエンド提供シード使用: ${JSON.stringify(actualSeeds)}`);
        } else if (seeds && Array.isArray(seeds) && seeds.length > 0) {
            // 部分的なシード配列の場合、ベースから連続生成
            const baseSeed = seeds[0];
            actualSeeds = Array.from({ length: numberOfImages }, (_, i) => baseSeed + i);
            console.log(`[DEBUG] ベースシードから連続生成: base=${baseSeed}, seeds=${JSON.stringify(actualSeeds)}`);
        } else {
            // シード未指定の場合、ランダム生成
            actualSeeds = Array.from({ length: numberOfImages }, () => Math.floor(Math.random() * 1000000));
            console.log(`[DEBUG] ランダムシード生成: ${JSON.stringify(actualSeeds)}`);
        }
        
        // 🎯 各画像を個別に生成（並列処理）
        const generationPromises = actualSeeds.map(async (seed, index) => {
            try {
                console.log(`[DEBUG] 画像${index + 1}生成開始 (seed: ${seed})`);
                const result = await generateSingleImage(prompt, negativePrompt, width, height, seed);
                console.log(`[DEBUG] 画像${index + 1}生成完了 (seed: ${seed})`);
                return result;
            } catch (error) {
                console.error(`[ERROR] 画像${index + 1}生成エラー (seed: ${seed}):`, error);
                return null;
            }
        });
        
        const results = await Promise.all(generationPromises);
        const successfulImages = results.filter(result => result !== null);
        
        console.log(`[DEBUG] 複数画像生成完了: ${successfulImages.length}/${numberOfImages}枚成功`);
        
        if (successfulImages.length === 0) {
            throw new Error('すべての画像生成に失敗しました');
        }
        
        return {
            images: successfulImages,
            seeds: successfulImages.map(img => img.seed)
        };
        
    } catch (error) {
        console.error('[ERROR] 複数画像生成エラー:', error);
        throw new Error(`複数画像生成に失敗しました: ${error.message}`);
    }
}

export const handler = async (event) => {
    console.log('[DEBUG] Image Generation Request received via Lambda Function URL');
    
    // Lambda関数内でCORS完全制御（関数URLのCORS設定は無効化）
    const headers = {
        'Content-Type': 'application/json'
    };
    
    try {
        // Lambda関数URLの場合、requestContextが異なる
        const httpMethod = event.requestContext?.http?.method || event.httpMethod;
        
        if (httpMethod === 'OPTIONS') {
            return {
                statusCode: 200,
                headers,
                body: ''
            };
        }
        
        // 認証チェック
        const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
        const userId = extractUserIdFromToken(authHeader);
        
        if (!userId) {
            return {
                statusCode: 401,
                headers,
                body: JSON.stringify({
                    error: 'Unauthorized'
                })
            };
        }
        
        // リクエストボディの解析
        let body = {};
        if (event.body) {
            try {
                if (event.isBase64Encoded) {
                    body = JSON.parse(Buffer.from(event.body, 'base64').toString('utf-8'));
                } else {
                    body = JSON.parse(event.body);
                }
            } catch (parseError) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({
                        error: 'Invalid JSON in request body'
                    })
                };
            }
        }
        
        // 🎯 修正: seeds配列を受け取る
        const { prompt, negativePrompt, width, height, seeds, numberOfImages } = body;
        
        if (!prompt || prompt.trim() === '') {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    success: false,
                    error: 'プロンプトは必須です'
                })
            };
        }
        
        if (prompt.trim().length > 1000) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    success: false,
                    error: 'プロンプトは1000文字以内で入力してください'
                })
            };
        }
        
        const actualNumberOfImages = numberOfImages && numberOfImages >= 1 && numberOfImages <= 5 ? numberOfImages : 1;
        
        const validSizes = [512, 768, 1024, 1152, 1216, 1344, 1536];
        const actualWidth = width && validSizes.includes(width) ? width : 1024;
        const actualHeight = height && validSizes.includes(height) ? height : 1024;
        
        console.log(`[DEBUG] 画像生成リクエスト: userId=${userId}, prompt="${prompt}", size=${actualWidth}x${actualHeight}, 枚数=${actualNumberOfImages}, seeds=${JSON.stringify(seeds)}`);
        
        // 🎯 修正: seeds配列を渡す
        const result = await generateImages(
            prompt.trim(),
            negativePrompt?.trim(),
            actualWidth,
            actualHeight,
            seeds, // 🎯 seeds配列を渡す
            actualNumberOfImages
        );
        
        console.log(`[DEBUG] generateImages関数の戻り値:`, {
            hasImages: !!result.images,
            imagesCount: result.images ? result.images.length : 0,
            seeds: result.seeds
        });
        
        if (!result || !result.images || !Array.isArray(result.images) || result.images.length === 0) {
            console.error('[ERROR] 画像生成結果が不正です:', result);
            throw new Error('画像生成に失敗しました');
        }
        
        console.log(`[DEBUG] 生成された画像数: ${result.images.length}, 使用シード: ${JSON.stringify(result.seeds)}`);
        
        // S3にアップロード
        let s3Keys = [];
        let presignedUrls = [];
        try {
            s3Keys = await uploadImagesToS3(result.images, userId, prompt);
            console.log(`[DEBUG] S3保存結果: ${s3Keys.filter(key => key !== null).length}/${result.images.length}枚成功`);
            
            // S3 Presigned URLを生成
            presignedUrls = await Promise.all(
                s3Keys.map(async (s3Key) => {
                    if (!s3Key) return null;
                    
                    try {
                        const getObjectCommand = new GetObjectCommand({
                            Bucket: S3_BUCKET_NAME,
                            Key: s3Key
                        });
                        
                        // 1時間有効なPresigned URL生成
                        const presignedUrl = await getSignedUrl(s3Client, getObjectCommand, {
                            expiresIn: 3600 // 1時間
                        });
                        
                        console.log(`[DEBUG] Presigned URL生成完了: ${s3Key}`);
                        return presignedUrl;
                    } catch (error) {
                        console.error(`[ERROR] Presigned URL生成エラー: ${s3Key}`, error);
                        return null;
                    }
                })
            );
        } catch (s3Error) {
            console.error('[WARNING] S3アップロード失敗:', s3Error);
            s3Keys = new Array(result.images.length).fill(null);
            presignedUrls = new Array(result.images.length).fill(null);
        }
        
        // 🎯 修正: 各画像に正しいシード値を設定
        const images = result.images.map((imageData, index) => {
            return {
                s3Key: s3Keys[index] || null,
                presignedUrl: presignedUrls[index] || null,
                seed: imageData.seed, // 🎯 各画像の実際のシード値
                prompt: prompt,
                negativePrompt: negativePrompt || '',
                width: actualWidth,
                height: actualHeight,
                generatedAt: new Date().toISOString(),
                index: index + 1
            };
        });
        
        const responseData = {
            success: true,
            images: images,
            totalCount: images.length
        };
        
        console.log(`[DEBUG] レスポンス準備完了: ${images.length}枚の画像, シード値: ${images.map(img => img.seed).join(', ')}`);
        
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(responseData)
        };
        
    } catch (error) {
        console.error('[ERROR] Image Generation Error:', error);
        
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: '画像生成に失敗しました',
                details: error.message
            })
        };
    }
};