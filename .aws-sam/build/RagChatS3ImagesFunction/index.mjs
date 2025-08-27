import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// S3クライアント初期化
const s3Client = new S3Client({ region: process.env.AWS_REGION });
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

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

// 🎯 Presigned URL生成
async function generatePresignedUrl(s3Key) {
    try {
        console.log(`[DEBUG] Presigned URL生成開始: ${s3Key}`);
        
        const getObjectCommand = new GetObjectCommand({
            Bucket: S3_BUCKET_NAME,
            Key: s3Key,
            // キャッシュ最適化（60分に合わせて調整）
            ResponseCacheControl: 'max-age=3600, must-revalidate', // 1時間
            ResponseContentDisposition: 'inline', // ブラウザで直接表示
        });
        
        // 60分有効なPresigned URL生成
        const presignedUrl = await getSignedUrl(s3Client, getObjectCommand, {
            expiresIn: 3600 // 60分（3600秒）
        });
        
        const now = Date.now();
        const expiresAt = now + (3600 * 1000); // 60分後の期限時刻
        
        console.log(`[DEBUG] Presigned URL生成完了: ${s3Key}, expires at: ${new Date(expiresAt).toISOString()}`);
        
        return {
            presignedUrl,
            expiresIn: 3600, // 3600秒
            expiresAt,
            generatedAt: now,
            s3Key, // 再生成用
            method: 'presignedUrl'
        };
        
    } catch (error) {
        console.error('[ERROR] Presigned URL生成エラー:', error);
        throw new Error(`Presigned URLの生成に失敗しました: ${error.message}`);
    }
}

export const handler = async (event) => {
    const startTime = Date.now();
    console.log('[DEBUG] Presigned URL Request received');
    
    // CORSヘッダー設定
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'application/json'
    };
    
    try {
        const httpMethod = event.httpMethod || event.requestContext?.http?.method;
        
        // OPTIONSリクエストの処理
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
        
        const { s3Key } = body;
        
        if (!s3Key) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    error: 's3Key is required'
                })
            };
        }
        
        // セキュリティチェック
        if (s3Key.includes('..') || s3Key.includes('//')) {
            console.warn(`[SECURITY] Path traversal attempt: ${s3Key} by user: ${userId}`);
            return {
                statusCode: 403,
                headers,
                body: JSON.stringify({
                    error: 'Invalid s3Key format'
                })
            };
        }
        
        if (!s3Key.startsWith('uploads/')) {
            console.warn(`[SECURITY] Invalid prefix access: ${s3Key} by user: ${userId}`);
            return {
                statusCode: 403,
                headers,
                body: JSON.stringify({
                    error: 'Invalid s3Key format'
                })
            };
        }
        
        // ユーザー分離
        const expectedPrefix = `uploads/${userId}/`;
        if (!s3Key.startsWith(expectedPrefix)) {
            console.warn(`[SECURITY] Cross-user access attempt: ${s3Key} by user: ${userId}`);
            return {
                statusCode: 403,
                headers,
                body: JSON.stringify({
                    error: 'Access denied'
                })
            };
        }
        
        console.log(`[DEBUG] Presigned URL生成リクエスト: userId=${userId}, s3Key=${s3Key}`);
        
        // 🎯 Presigned URL生成（唯一の処理）
        const responseData = await generatePresignedUrl(s3Key);
        
        // 📊 構造化ログ
        const responseTime = Date.now() - startTime;
        console.log(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'INFO',
            message: 'Presigned URL generated successfully',
            userId,
            s3Key,
            responseTime,
            expiresAt: responseData.expiresAt,
            method: 'presignedUrl'
        }));
        
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(responseData)
        };
        
    } catch (error) {
        const responseTime = Date.now() - startTime;
        
        // エラーログ
        console.error(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message: 'Presigned URL generation failed',
            error: error.message,
            userId: userId || 'unknown',
            s3Key: body?.s3Key || 'unknown',
            responseTime
        }));
        
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: 'Presigned URLの生成に失敗しました',
                details: error.message
            })
        };
    }
};