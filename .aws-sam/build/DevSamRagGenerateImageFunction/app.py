def lambda_handler(event, context):
    print("Lambda executed!")
    return {"statusCode": 200, "body": "OK"}
