# Private document storage

VistaBlox follows `Docs/Backend/08-Integrations/MINIO_STORAGE.md`: MinIO has no public URL, and the Express API proxies every authorized document download. The API uses MinIO's S3-compatible protocol through `@aws-sdk/client-s3`; it does not generate presigned URLs.

## Bucket boundaries

Buckets are security and retention boundaries, not document-type folders. The startup initializer creates these buckets idempotently:

- `vistablox-quarantine`: untrusted uploads; automatically expires after 30 days.
- `vistablox-private`: intake/property evidence and internal case documents.
- `vistablox-kyc`: identity and compliance documents with the strictest access policy.
- `vistablox-disclosures`: published offering packs; versioned and object-lock capable.
- `vistablox-audit`: audit/legal records; versioned and object-lock capable.

Use prefixes within a bucket, for example `intake/{case_id}/revisions/{revision}/{document_id}` (case documents) or `offerings/{offering_id}/{document_id}` (disclosure documents — keyed by offering, not by pack, since one upload may be quoted by several pack versions). Keys are server-generated and must not contain original filenames, account emails, or other personal data; the original filename is kept on the metadata row (`stored_documents.original_filename`) and, ASCII-reduced, in the object's `original-filename` user metadata. The `objectKey` helper in `src/infrastructure/storage/storage-buckets.ts` enforces the shape (letters of either case, digits, `/`, `_`, `-`; no `..`) — subject ids embed upper-case ULIDs.


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

Two staff upload paths exist, both through the API, both raw-body `POST`s described by headers (`Content-Type`, `X-Document-Type`, `X-Original-Filename`): `POST /internal/v1/intake-cases/:case_id/documents` writes case documents to the private bucket, and `POST /internal/v1/offerings/:offering_id/documents` writes disclosure documents to the disclosures bucket (see [`docs/investor-offering.md`](investor-offering.md#uploading-disclosure-documents)). Neither goes through the quarantine bucket: the whole file is buffered in the API process, checked against the MIME allowlist and the 100 MB cap, SHA-256 hashed, and handed to ClamAV, and only a clean file is written — once, straight into its canonical bucket — before its metadata row is created in the same request (the object is deleted again if that row cannot be written). A scanner that cannot be reached fails the upload closed (`503`). Clients never receive credentials or a key to write under; the key is server-generated. Every canonical object has a `platform.stored_documents` row containing bucket, key, version ID, document type, owning case/account/offering, checksum, size, content type, original filename, creation time, classification, and retention deadline. Authorization is decided from that row and domain state, never from an object listing: a disclosure pack may only quote a `document_ref` that is an accepted, non-deleted row of its own offering, and the staff download of either path only serves refs that resolve to such a row.

Application credentials are least-privilege service credentials; the MinIO root account is reserved for provisioning and emergency administration. Production must add TLS, external KMS-backed encryption, multi-node/multi-drive availability, tested backups, and replication to a separate failure domain. Retention and legal-hold periods require approval from the applicable legal/compliance owner before lifecycle rules are expanded beyond quarantine.

## Server version posture

MinIO's upstream repository was archived on 2026-04-25. Its final security release, `RELEASE.2025-10-15T17-29-55Z`, fixed a privilege-escalation vulnerability but was not published as an official container tag. The Compose image therefore builds that exact source tag and embeds its release metadata instead of pulling the older `minio/minio:latest` image.

References:

- [MinIO final security release](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z)
- [MinIO JavaScript/S3 object-download contract](https://github.com/minio/minio-js/blob/master/docs/API.md#getobjectbucketname-objectname-getopts)
- [AWS SDK v3 streaming S3 responses](https://github.com/aws/aws-sdk-js-v3/blob/main/supplemental-docs/CLIENTS.md)

The archived upstream is now an explicit infrastructure-lifecycle risk. This implementation satisfies the selected architecture, but provider/server replacement should be revisited before production launch rather than treating an archived storage server as indefinitely maintained.
