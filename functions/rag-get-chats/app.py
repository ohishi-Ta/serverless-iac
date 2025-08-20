import json
import os
import boto3

REGION_NAME = os.environ['AWS_REGION']
CHAT_TABLE_NAME = os.environ['DYNAMODB_TABLE_NAME']

dynamodb = boto3.resource('dynamodb', region_name=REGION_NAME)
chat_table = dynamodb.Table(CHAT_TABLE_NAME)

def lambda_handler(event, context):
    try:
        # JWT認証からユーザーIDを取得 (HTTP API用)
        user_id = event['requestContext']['authorizer']['jwt']['claims']['sub']
        
        response = chat_table.get_item(Key={'userId': user_id})
        
        item = response.get('Item', {})
        all_chats = item.get('chats', [])
        
        chat_list_for_sidebar = []
        for chat in all_chats:
            chat_list_for_sidebar.append({
                'id': chat.get('id'),
                'title': chat.get('title')
            })

        return {
            'statusCode': 200,
            'headers': { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                'Access-Control-Allow-Methods': 'GET,OPTIONS'
            },
            'body': json.dumps(chat_list_for_sidebar, ensure_ascii=False)
        }
    except Exception as e:
        print(f"Error: {e}")
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({'error': 'Internal server error'})
        }