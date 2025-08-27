import json
import os
import boto3
import logging
from decimal import Decimal

# ログ設定
logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION_NAME = os.environ['AWS_REGION']
CHAT_TABLE_NAME = os.environ['DYNAMODB_TABLE_NAME']

dynamodb = boto3.resource('dynamodb', region_name=REGION_NAME)
chat_table = dynamodb.Table(CHAT_TABLE_NAME)

class DecimalEncoder(json.JSONEncoder):
    """DynamoDB Decimal型をJSON serializable に変換するカスタムエンコーダー"""
    def default(self, obj):
        if isinstance(obj, Decimal):
            # Decimal を int または float に変換
            if obj % 1 == 0:
                return int(obj)
            else:
                return float(obj)
        return super(DecimalEncoder, self).default(obj)

def process_attachment(attachment):
    """添付ファイル情報を安全に処理（S3キー対応版）"""
    if not attachment:
        return None
    
    try:
        processed_attachment = {
            'fileName': attachment.get('fileName', ''),
            'fileType': attachment.get('fileType', ''),
            'size': attachment.get('size', 0)
        }
        
        # S3キーがある場合は保持（フロントエンドで画像復元に使用）
        if 's3Key' in attachment and attachment['s3Key']:
            processed_attachment['s3Key'] = attachment['s3Key']
            logger.info(f"S3キー付きファイル: {attachment.get('fileName')} -> {attachment['s3Key']}")
        
        # 下位互換性: 旧形式のdataフィールドも保持
        if 'data' in attachment and attachment['data']:
            # 注意: 通常、履歴保存時にはBase64データは保存されていない
            processed_attachment['data'] = attachment['data']
        
        # displayURL（旧形式との互換性）
        if 'displayUrl' in attachment:
            processed_attachment['displayUrl'] = attachment['displayUrl']
        
        # noteフィールド（エラーメッセージなど）
        if 'note' in attachment:
            processed_attachment['note'] = attachment['note']
        
        return processed_attachment
        
    except Exception as e:
        logger.error(f"添付ファイル処理エラー: {e}")
        # エラー時は基本情報のみ返す
        return {
            'fileName': attachment.get('fileName', 'Unknown file'),
            'fileType': attachment.get('fileType', ''),
            'size': attachment.get('size', 0),
            'note': '添付ファイルの処理中にエラーが発生しました'
        }

def get_chat_messages(user_id, chat_id):
    """チャットメッセージを取得する関数"""
    try:
        # DynamoDBからユーザーの全チャットデータを取得
        response = chat_table.get_item(Key={'userId': user_id})
        all_chats = response.get('Item', {}).get('chats', [])
        
        # 指定されたchatIdに対応するメッセージを検索
        target_messages = []
        for chat in all_chats:
            if chat.get('id') == chat_id:
                target_messages = chat.get('messages', [])
                break
        
        if not target_messages:
            logger.warning(f"チャット {chat_id} が見つかりません")
            return None
        
        # メッセージを安全に処理（S3キー対応）
        processed_messages = []
        
        for message in target_messages:
            try:
                processed_message = {
                    'id': message.get('id', ''),
                    'role': message.get('role', ''),
                    'content': message.get('content', ''),
                }
                
                # モード・モデル情報（オプション）
                if 'mode' in message:
                    processed_message['mode'] = message['mode']
                if 'model' in message:
                    processed_message['model'] = message['model']
                
                # 添付ファイル処理（S3キー対応）
                if 'attachment' in message and message['attachment']:
                    processed_attachment = process_attachment(message['attachment'])
                    if processed_attachment:
                        processed_message['attachment'] = processed_attachment
                
                processed_messages.append(processed_message)
                
            except Exception as e:
                logger.error(f"メッセージ処理エラー (messageId: {message.get('id', 'unknown')}): {e}")
                # エラーが発生したメッセージもスキップせずに基本情報で追加
                processed_messages.append({
                    'id': message.get('id', str(len(processed_messages))),
                    'role': message.get('role', 'unknown'),
                    'content': message.get('content', 'メッセージの処理中にエラーが発生しました'),
                    'note': 'メッセージ処理エラー'
                })
        
        logger.info(f"チャット {chat_id} のメッセージ数: {len(processed_messages)} (処理完了)")
        return processed_messages
        
    except Exception as e:
        logger.error(f"チャットメッセージ取得エラー: {e}")
        raise

def delete_chat(user_id, chat_id):
    """指定されたチャットをDynamoDBから削除する関数"""
    try:
        # 現在のチャットデータを取得
        response = chat_table.get_item(Key={'userId': user_id})
        
        if 'Item' not in response:
            logger.warning(f"ユーザー {user_id} のチャットデータが見つかりません")
            return False
        
        all_chats = response['Item'].get('chats', [])
        
        # 指定されたchat_idのチャットを削除
        updated_chats = [chat for chat in all_chats if chat.get('id') != chat_id]
        
        # 削除されたかチェック
        if len(updated_chats) == len(all_chats):
            logger.warning(f"削除対象のチャット {chat_id} が見つかりません")
            return False
        
        # DynamoDBを更新
        chat_table.update_item(
            Key={'userId': user_id},
            UpdateExpression='SET chats = :chats',
            ExpressionAttributeValues={
                ':chats': updated_chats
            }
        )
        
        logger.info(f"チャット {chat_id} を正常に削除しました (残りチャット数: {len(updated_chats)})")
        return True
        
    except Exception as e:
        logger.error(f"チャット削除エラー: {e}")
        raise

def lambda_handler(event, context):
    """HTTPメソッドに応じてチャット操作を処理するLambda関数"""
    
    # CORS headers
    cors_headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,DELETE,OPTIONS'
    }
    
    try:
        # デバッグ用：完全なイベント構造をログ出力
        logger.info("=== 受信イベントの完全構造 ===")
        logger.info(json.dumps(event, default=str, ensure_ascii=False, indent=2))
        logger.info("=== イベント構造終了 ===")
        
        # HTTPメソッドを複数の方法で取得を試行
        http_method = None
        
        # 方法1: 直接httpMethodから
        if 'httpMethod' in event:
            http_method = event['httpMethod']
            logger.info(f"方法1でHTTPメソッド取得: {http_method}")
        
        # 方法2: requestContextから
        elif 'requestContext' in event and 'httpMethod' in event['requestContext']:
            http_method = event['requestContext']['httpMethod']
            logger.info(f"方法2でHTTPメソッド取得: {http_method}")
        
        # 方法3: requestContextのhttp内から
        elif 'requestContext' in event and 'http' in event['requestContext'] and 'method' in event['requestContext']['http']:
            http_method = event['requestContext']['http']['method']
            logger.info(f"方法3でHTTPメソッド取得: {http_method}")
        
        # 方法4: resourceから推測（最後の手段）
        elif 'resource' in event:
            resource = event['resource']
            logger.info(f"リソース情報: {resource}")
            # リソース情報から推測するロジックを追加可能
        
        if http_method:
            http_method = http_method.upper()
            logger.info(f"最終HTTPメソッド: '{http_method}'")
        else:
            logger.error("すべての方法でHTTPメソッドの取得に失敗")
            logger.info(f"イベントのキー一覧: {list(event.keys())}")
            if 'requestContext' in event:
                logger.info(f"requestContextのキー一覧: {list(event['requestContext'].keys())}")
        
        # OPTIONSリクエスト（プリフライト）の処理
        if http_method == 'OPTIONS':
            logger.info("プリフライトリクエストを処理")
            return {
                'statusCode': 200,
                'headers': cors_headers,
                'body': ''
            }
        
        # HTTPメソッドが取得できない場合
        if not http_method:
            logger.error("HTTPメソッドが取得できません")
            return {
                'statusCode': 400,
                'headers': cors_headers,
                'body': json.dumps({
                    'error': 'HTTP method not found in request',
                    'debug': {
                        'eventKeys': list(event.keys()),
                        'requestContextKeys': list(event.get('requestContext', {}).keys()) if 'requestContext' in event else None
                    }
                }, cls=DecimalEncoder)
            }
        
        # JWT認証からユーザーIDを取得
        try:
            user_id = event['requestContext']['authorizer']['jwt']['claims']['sub']
            logger.info(f"ユーザーID: {user_id}")
        except (KeyError, TypeError) as e:
            logger.error(f"認証情報取得エラー: {e}")
            logger.info(f"requestContext構造: {json.dumps(event.get('requestContext', {}), default=str)}")
            return {
                'statusCode': 401,
                'headers': cors_headers,
                'body': json.dumps({'error': 'Authentication failed'}, cls=DecimalEncoder)
            }
        
        # GETリクエスト: チャット履歴取得
        if http_method == 'GET':
            # パスパラメータからchatIdを取得
            try:
                chat_id = event['pathParameters']['chatId']
                logger.info(f"チャット {chat_id} の履歴を取得します")
            except (KeyError, TypeError):
                logger.error(f"pathParameters構造: {event.get('pathParameters', {})}")
                return {
                    'statusCode': 400,
                    'headers': cors_headers,
                    'body': json.dumps({'error': 'Chat ID not found in path parameters'}, cls=DecimalEncoder)
                }
            
            messages = get_chat_messages(user_id, chat_id)
            
            if messages is None:
                return {
                    'statusCode': 404,
                    'headers': cors_headers,
                    'body': json.dumps({'error': 'Chat not found'}, cls=DecimalEncoder)
                }
            
            return {
                'statusCode': 200,
                'headers': cors_headers,
                'body': json.dumps(messages, ensure_ascii=False, cls=DecimalEncoder)
            }
        
        # DELETEリクエスト: 個別チャット削除
        elif http_method == 'DELETE':
            # パスパラメータからchatIdを取得
            try:
                chat_id = event['pathParameters']['chatId']
                logger.info(f"チャット {chat_id} を削除します")
            except (KeyError, TypeError):
                logger.error(f"pathParameters構造: {event.get('pathParameters', {})}")
                return {
                    'statusCode': 400,
                    'headers': cors_headers,
                    'body': json.dumps({'error': 'Chat ID not found in path parameters'}, cls=DecimalEncoder)
                }
            
            success = delete_chat(user_id, chat_id)
            
            if not success:
                return {
                    'statusCode': 404,
                    'headers': cors_headers,
                    'body': json.dumps({'error': 'Chat not found or already deleted'}, cls=DecimalEncoder)
                }
            
            return {
                'statusCode': 200,
                'headers': cors_headers,
                'body': json.dumps({'success': True, 'message': 'Chat deleted successfully'}, cls=DecimalEncoder)
            }
        
        # サポートされていないHTTPメソッド
        else:
            logger.warning(f"サポートされていないHTTPメソッド: '{http_method}'")
            return {
                'statusCode': 405,
                'headers': cors_headers,
                'body': json.dumps({'error': f'Method {http_method} not allowed'}, cls=DecimalEncoder)
            }
        
    except KeyError as e:
        logger.error(f"必要なパラメータが見つかりません: {e}")
        return {
            'statusCode': 400,
            'headers': cors_headers,
            'body': json.dumps({'error': f'Missing required parameters: {str(e)}'}, cls=DecimalEncoder)
        }
        
    except Exception as e:
        logger.error(f"Lambda実行中にエラー発生: {str(e)}")
        import traceback
        logger.error(f"スタックトレース: {traceback.format_exc()}")
        
        return {
            'statusCode': 500,
            'headers': cors_headers,
            'body': json.dumps({'error': 'Internal server error'}, cls=DecimalEncoder)
        }