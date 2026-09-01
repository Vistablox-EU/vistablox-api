# Private document storage

VistaBlox follows `Docs/Backend/08-Integrations/MINIO_STORAGE.md`: MinIO has no host port or public URL, and the Express API proxies every authorized document download. The API uses MinIO's S3-compatible protocol through `@aws-sdk/client-s3`; it does not generate presigned URLs.

## Runtime configuration

Configure all of these values together:

- `MINIO_ENDPOINT`
- `MINIO_PORT`
- `MINIO_USE_SSL`
- `MINIO_ACCESS_KEY`
- `MINIO_SECRET_KEY`
- `MINIO_DOCUMENT_BUCKET`

If storage is not configured, disclosure metadata remains readable but a download attempt fails closed with `infrastructure.document_storage_unavailable` (`503`). The local Compose stack starts MinIO without publishing ports, creates the configured private bucket through a one-shot initializer, and makes the API wait for both storage health and bucket initialization.

## Server version posture

MinIO's upstream repository was archived on 2026-04-25. Its final security release, `RELEASE.2025-10-15T17-29-55Z`, fixed a privilege-escalation vulnerability but was not published as an official container tag. The Compose image therefore builds that exact source tag and embeds its release metadata instead of pulling the older `minio/minio:latest` image.

References:

- [MinIO final security release](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z)
- [MinIO JavaScript/S3 object-download contract](https://github.com/minio/minio-js/blob/master/docs/API.md#getobjectbucketname-objectname-getopts)
- [AWS SDK v3 streaming S3 responses](https://github.com/aws/aws-sdk-js-v3/blob/main/supplemental-docs/CLIENTS.md)

The archived upstream is now an explicit infrastructure-lifecycle risk. This implementation satisfies the selected architecture, but provider/server replacement should be revisited before production launch rather than treating an archived storage server as indefinitely maintained.
