"""Solve Anny's shape parameters so the body's own measurements match the recorded ones."""

from __future__ import annotations

import time
from dataclasses import dataclass

import torch

from .measure import Evaluator, Measures
from .model import BodyModel, Shape

VERSION = "anny-0.6.2+fit-1"
TOLERANCE = 0.005  # metres; a residual of this size costs as much as one unit of prior
PRIOR_LOCAL = 0.4
PRIOR_PHENOTYPE = 2.0


@dataclass
class FitResult:
    shape: Shape
    values: dict[tuple[str, str], float]  # metres, measured on the fitted body
    seconds: float


def _raw(shape: Shape) -> tuple[torch.Tensor, torch.Tensor]:
    p = shape.phenotypes.clamp(1e-4, 1 - 1e-4)
    loc = shape.local.clamp(-0.999, 0.999)
    return torch.logit(p).detach().clone(), torch.atanh(loc).detach().clone()


class Fitter:
    def __init__(self, model: BodyModel, measures: Measures):
        self.model = model
        self.measures = measures
        self.subset = model.subset(measures.index)
        self.all = Evaluator(measures)

    def measure(self, shape: Shape) -> dict[tuple[str, str], float]:
        with torch.no_grad():
            v = self.subset(shape)
            values = self.all.values(v, self.all.plan(v))
        return {k: float(x) for k, x in zip(self.all.keys, values)}

    def fit(
        self,
        targets: dict[tuple[str, str], float],
        start: Shape | None = None,
        rounds: int = 3,
        steps: int = 30,
    ) -> FitResult:
        began = time.perf_counter()
        keys = [k for k in targets if k in self.measures.local]
        if not keys:
            shape = Shape.neutral()
            return FitResult(shape, self.measure(shape), time.perf_counter() - began)
        evaluator = Evaluator(self.measures, keys)
        goal = torch.tensor([targets[k] for k in keys])
        p_raw, l_raw = _raw(start or Shape.neutral())
        p_raw.requires_grad_(True)
        l_raw.requires_grad_(True)

        def shape_of():
            return Shape(torch.sigmoid(p_raw), torch.tanh(l_raw))

        for _ in range(rounds):
            with torch.no_grad():
                plan = evaluator.plan(self.subset(shape_of()))
            opt = torch.optim.LBFGS([p_raw, l_raw], lr=1, max_iter=steps, line_search_fn="strong_wolfe")

            def closure():
                opt.zero_grad()
                s = shape_of()
                got = evaluator.values(self.subset(s), plan)
                loss = (((got - goal) / TOLERANCE) ** 2).sum()
                loss = loss + PRIOR_LOCAL * (s.local**2).sum()
                loss = loss + PRIOR_PHENOTYPE * ((s.phenotypes - 0.5) ** 2).sum()
                loss.backward()
                return loss

            opt.step(closure)
        shape = Shape(torch.sigmoid(p_raw).detach(), torch.tanh(l_raw).detach())
        return FitResult(shape, self.measure(shape), time.perf_counter() - began)
