-- AD-256's escrow campaign needs a concrete token_id to open against before
-- any minting can happen (minting only happens after a campaign succeeds),
-- which is earlier than AD-163's original "once minted" framing for
-- pivs.token_id. This sequence lets token_id be assigned deterministically
-- and collision-free at Piv-creation time (open-offering-for-approved-case)
-- instead.
CREATE SEQUENCE "origination"."piv_token_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
