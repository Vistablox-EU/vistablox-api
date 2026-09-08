-- The native-client OIDC provider subsystem (oidc-provider, AD-169) has been
-- removed: nothing ever authenticated through it in production
-- (oidc_model_instances had zero rows), and native mobile/desktop now
-- authenticates the same way as web -- a Better Auth session, sent as a
-- bearer token via the Authorization header instead of a cookie.
DROP TABLE "oidc_model_instances";
