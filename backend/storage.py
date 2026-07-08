import os
import boto3
from botocore.client import Config
from starlette.concurrency import run_in_threadpool

R2_ACCOUNT_ID = os.environ["R2_ACCOUNT_ID"]
R2_ACCESS_KEY_ID = os.environ["R2_ACCESS_KEY_ID"]
R2_SECRET_ACCESS_KEY = os.environ["R2_SECRET_ACCESS_KEY"]


class R2Client:
    def __init__(self, bucket: str) -> None:
        self.bucket = bucket
        self.client = boto3.client(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        config=Config(
            signature_version="s3v4",
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        ),
        region_name="auto"
    )
    
    def upload_html(self, data:bytes, key:str) -> None:
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType="text/html")

r2_client = R2Client(bucket=os.environ["R2_BUCKET"])
