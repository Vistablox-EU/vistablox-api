# Private document storage

VistaBlox follows `Docs/Backend/08-Integrations/MINIO_STORAGE.md`: MinIO has no public URL, and the Express API proxies every authorized document download. The API uses MinIO's S3-compatible protocol through `@aws-sdk/client-s3`; it does not generate presigned URLs.

## Bucket boundaries

Buckets are security and retention boundaries, not document-type folders. The startup initializer creates these buckets idempotently:

- `vistablox-quarantine`: untrusted uploads; automatically expires after 30 days.
- `vistablox-private`: intake/property evidence and internal case documents.
- `vistablox-kyc`: identity and compliance documents with the strictest access policy.
- `vistablox-disclosures`: published offering packs; versioned and object-lock capable.
- `vistablox-audit`: audit/legal records; versioned and object-lock capable.

Use prefixes within a bucket, for example `intake/{case_id}/submissions/{revision}/{document_id}` or `offerings/{offering_id}/packs/{pack_id}/{document_id}`. Keys are server-generated and must not contain original filenames, account emails, or other personal data. The `objectKey` helper in `src/infrastructure/storage/storage-buckets.ts` enforces the shape.


## Runtime configuration

Configure all of these values together:

- `MINIO_ENDPOINT`
- `MINIO_PORT`
- `MINIO_USE_SSL`
- `MINIO_ACCESS_KEY`
- `MINIO_SECRET_KEY`
- `MINIO_QUARANTINE_BUCKET` (default `vistablox-quarantine`)
- `MINIO_PRIVATE_BUCKET` (default `vistablox-private`)
- `MINIO_KYC_BUCKET` (default `vistablox-kyc`)
- `MINIO_DISCLOSURES_BUCKET` (default `vistablox-disclosures`)
- `MINIO_AUDIT_BUCKET` (default `vistablox-audit`)

If storage is not configured, disclosure metadata remains readable but a download attempt fails closed with `infrastructure.document_storage_unavailable` (`503`). Both local and staging Compose stacks start MinIO, create all configured buckets through a one-shot initializer, enable versioning on mutable/private buckets, enable object locking on disclosure/audit buckets, and apply quarantine lifecycle rules. Staging overrides `MINIO_ENDPOINT` to the internal `minio` service name; credentials belong in `.env.staging` (or the deployment secret store).

## Upload and metadata contract

Uploads should first land in quarantine, then be validated (size, declared MIME type, magic bytes, checksum, and malware scan) before being copied to a canonical bucket. A future upload-intent endpoint must issue one-time scoped credentials and never allow arbitrary bucket/key writes. Every canonical object must have a database metadata row containing bucket, key, version ID, document type, owning case/account/offering, checksum, size, content type, creation time, classification, and retention deadline. Authorization is decided from that row and domain state, never from an object listing.

Application credentials are least-privilege service credentials; the MinIO root account is reserved for provisioning and emergency administration. Production must add TLS, external KMS-backed encryption, multi-node/multi-drive availability, tested backups, and replication to a separate failure domain. Retention and legal-hold periods require approval from the applicable legal/compliance owner before lifecycle rules are expanded beyond quarantine.

## Server version posture

MinIO's upstream repository was archived on 2026-04-25. Its final security release, `RELEASE.2025-10-15T17-29-55Z`, fixed a privilege-escalation vulnerability but was not published as an official container tag. The Compose image therefore builds that exact source tag and embeds its release metadata instead of pulling the older `minio/minio:latest` image.

References:

- [MinIO final security release](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z)
- [MinIO JavaScript/S3 object-download contract](https://github.com/minio/minio-js/blob/master/docs/API.md#getobjectbucketname-objectname-getopts)
- [AWS SDK v3 streaming S3 responses](https://github.com/aws/aws-sdk-js-v3/blob/main/supplemental-docs/CLIENTS.md)

The archived upstream is now an explicit infrastructure-lifecycle risk. This implementation satisfies the selected architecture, but provider/server replacement should be revisited before production launch rather than treating an archived storage server as indefinitely maintained.
