-- Manual DDL. There is no migration tooling in this repo yet, so schema changes
-- are applied by hand against Neon and recorded here. Safe to re-run.

CREATE TABLE IF NOT EXISTS global_params (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    version         integer NOT NULL UNIQUE,

    -- Preprocessing and the user-tower prior. Dimension must match
    -- EMBEDDING_DIM in .env (384).
    sigma           vector(384) NOT NULL,
    z_global        vector(384) NOT NULL,

    -- Calibration and decision.
    a               double precision NOT NULL,
    b               double precision NOT NULL,
    kappa           double precision NOT NULL,
    threshold       double precision NOT NULL,

    -- Retraining the CNN invalidates sigma and z_global, so a param set is only
    -- meaningful alongside the encoder whose embeddings it was fit on.
    encoder_version text NOT NULL,

    metrics         jsonb,
    n_pages         integer,
    n_labels        integer,
    n_users         integer,

    is_active       boolean NOT NULL DEFAULT false,
    fitted_at       timestamptz NOT NULL DEFAULT now()
);

-- Exactly one active row; GET /params reads it on every device poll.
CREATE UNIQUE INDEX IF NOT EXISTS uq_global_params_active
    ON global_params (is_active) WHERE is_active;
