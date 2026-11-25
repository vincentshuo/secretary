# Fit the body profile onto NAVER Anny inside the sidecar

**Status: accepted (2026-11-23).**

The body profile shows a parametric human body that follows the 22 measurements kept by the personal clothing measurement guide. We reuse an existing body model instead of drawing our own. We run NAVER's [Anny](https://github.com/naver/anny) at runtime: its code is Apache-2.0, and its MakeHuman/MPFB2-derived assets are CC0. The version is pinned to 0.6.2 in `uv.lock`, and the model runs on the CPU inside the sidecar. Edison owns only what Anny lacks: tailoring measurement definitions on Anny's mesh, a fitter from measurements to shape parameters, and the HTTP surface.

## Considered and rejected

- **SMPL, SMPL-X, STAR, SUPR, SKEL and Virtual Caliper.** Their licences forbid redistributing the model and its derivatives, so they cannot ship in this public repository.
- **MakeHuman's measurement plugin.** Its vertex rulers live in AGPL code. Our girths and paths are derived independently, by sectioning the body with planes and following the taut-tape hull.
- **Baking the body into a GLB and fitting in the browser.** This was a workaround for the 2.5 GB server and became unnecessary once ADR 0022 removed that limit.
- **Meta MHR.** Its PCA shape space has no interpretable measurement controls.

## Boundaries

- Only Anny's default `anny` topology, its rig and its CC0 data are used. The `smplx` and `smpl` topologies download non-commercial assets, and packaging fails if any `noncommercial` directory appears. warp is excluded, and skinning uses Anny's `lbs`.
- Fitting evaluates Anny's own blendshape coefficients and rest vertices. The vectorised coefficient path must stay identical to upstream `_get_phenotype_blendshape_coefficients`; a test enforces this.
- Recorded values are the source of truth. Fitted shapes are a cache keyed by the fitter version, so changing the fitter invalidates them instead of silently reinterpreting history.
- Anny's local measurement targets are symmetric. Per-side differences can appear only where Anny has per-side targets (arms, hands, legs); the shoulder-length difference is shown as numbers, not as asymmetric geometry.
