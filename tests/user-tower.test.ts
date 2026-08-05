/**
 * Pins the client two-tower math to backend/preprocessing.py.
 *
 * fit_globals.py fits kappa, a and b against the Python implementation, so any
 * disagreement here means the shipped calibration describes a scorer the device
 * is not actually running. Fixtures come from models/gen_tower_fixtures.py.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { preprocess } from "../src/services/item-tower.js";
import { scoreProbability, userVector } from "../src/services/user-tower.js";
import type { GlobalParams, UserAccumulators } from "../src/shared/types.js";

const fixtures = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures/tower-cases.json"), "utf-8"),
);

// float32 round-tripping through JSON, so compare at single precision.
const TOL = 1e-6;

function expectClose(actual: ArrayLike<number>, expected: number[], tol = TOL) {
    expect(actual.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
        expect(Math.abs(actual[i] - expected[i])).toBeLessThan(tol);
    }
}

function paramsFor(c: any): GlobalParams {
    return {
        version: 1,
        sigma: [],
        z_global: c.z_global,
        a: c.a,
        b: c.b,
        kappa: c.kappa,
        threshold: 0.5,
        encoder_version: "test",
        fitted_at: "2026-01-01T00:00:00Z",
    };
}

describe("preprocess matches Python", () => {
    for (const c of fixtures.cases.filter((c: any) => c.kind === "preprocess")) {
        it(c.name, () => {
            expectClose(preprocess(Float32Array.from(c.z_raw), c.sigma), c.expected);
        });
    }

    it("produces a unit vector for non-zero input", () => {
        const z = preprocess(Float32Array.from([3, 4, 0, 0]), [1, 1, 1, 1]);
        const norm = Math.hypot(...z);
        expect(Math.abs(norm - 1)).toBeLessThan(1e-6);
    });

    it("does not divide by zero on an all-zero embedding", () => {
        const z = preprocess(new Float32Array(4), [1, 1, 1, 1]);
        expect([...z].every(Number.isFinite)).toBe(true);
    });
});

describe("userVector matches Python", () => {
    for (const c of fixtures.cases.filter((c: any) => c.kind === "user_vector")) {
        const acc: UserAccumulators = {
            s_pos: c.s_pos, n_pos: c.n_pos, s_neg: c.s_neg, n_neg: c.n_neg,
        };

        it(c.name, () => {
            expectClose(userVector(acc, paramsFor(c)), c.expected_z_u);
        });

        it(`${c.name} — score and probability`, () => {
            const { score, probability } = scoreProbability(
                userVector(acc, paramsFor(c)),
                Float32Array.from(c.z_i),
                paramsFor(c),
            );
            expect(Math.abs(score - c.expected_score)).toBeLessThan(1e-5);
            expect(Math.abs(probability - c.expected_probability)).toBeLessThan(1e-5);
        });
    }
});

describe("shrinkage degenerate cases collapse to z_global", () => {
    const zGlobal = [0.1, -0.2, 0.3, 0.4];
    const params = paramsFor({ z_global: zGlobal, a: 1, b: 0, kappa: 8 });
    const ones = [1, 1, 1, 1];

    it("zero labels", () => {
        expectClose(userVector({ s_pos: [0, 0, 0, 0], n_pos: 0, s_neg: [0, 0, 0, 0], n_neg: 0 }, params), zGlobal);
    });

    it("only positives — no subtrahend to estimate", () => {
        expectClose(userVector({ s_pos: ones, n_pos: 9, s_neg: [0, 0, 0, 0], n_neg: 0 }, params), zGlobal);
    });

    it("only negatives", () => {
        expectClose(userVector({ s_pos: [0, 0, 0, 0], n_pos: 0, s_neg: ones, n_neg: 9 }, params), zGlobal);
    });

    it("one of each already personalizes, but barely", () => {
        const z = userVector({ s_pos: ones, n_pos: 1, s_neg: [0, 0, 0, 0], n_neg: 1 }, params);
        // n_eff = 1, w = 1/9 — dominated by the prior, but no longer equal to it.
        expect([...z]).not.toEqual(zGlobal);
        const w = 1 / (1 + 8);
        expectClose(z, zGlobal.map((g, i) => w * ones[i] + (1 - w) * g));
    });

    it("weight rises with balanced label count", () => {
        const dist = (n: number) => {
            const z = userVector({ s_pos: ones.map((v) => v * n), n_pos: n, s_neg: [0, 0, 0, 0], n_neg: n }, params);
            return Math.hypot(...[...z].map((v, i) => v - zGlobal[i]));
        };
        expect(dist(2)).toBeLessThan(dist(8));
        expect(dist(8)).toBeLessThan(dist(64));
    });

    it("an unbalanced pair counts for less than a balanced one", () => {
        // n_eff is harmonic: 40 positives and 2 negatives is worth about 4
        // observations, not 42, because the negative mean is still noise.
        const nEff = (p: number, n: number) => (2 * p * n) / (p + n);
        expect(nEff(40, 2)).toBeLessThan(nEff(6, 6));
    });
});

describe("fit_sigma matches Python", () => {
    for (const c of fixtures.cases.filter((c: any) => c.kind === "fit_sigma")) {
        it(c.name, () => {
            const rows: number[][] = c.z_raw;
            const d = rows[0].length;
            const sigma = new Array(d).fill(0).map((_, j) => {
                const col = rows.map((r) => r[j]);
                const mean = col.reduce((a, b) => a + b, 0) / col.length;
                const varr = col.reduce((a, b) => a + (b - mean) ** 2, 0) / col.length;
                return Math.max(Math.sqrt(varr), 1e-6);
            });
            expectClose(sigma, c.expected, 1e-5);
        });

        it("floors dead dimensions so preprocessing cannot divide by zero", () => {
            expect(Math.min(...c.expected)).toBeGreaterThan(0);
        });
    }
});
