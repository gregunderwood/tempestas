"""Ordinary least squares on (x, y) points, shared by the fit scripts."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Line:
    intercept: float
    slope: float

    def predict(self, x: float) -> float:
        return self.intercept + self.slope * x


def fit_least_squares_line(points: list[tuple[float, float]]) -> Line | None:
    """The line y = intercept + slope * x, or None when every x is the same."""
    count = len(points)
    sum_x = sum(point[0] for point in points)
    sum_y = sum(point[1] for point in points)
    sum_xx = sum(point[0] * point[0] for point in points)
    sum_xy = sum(point[0] * point[1] for point in points)
    denominator = count * sum_xx - sum_x * sum_x
    if denominator == 0:
        return None
    slope = (count * sum_xy - sum_x * sum_y) / denominator
    intercept = (sum_y - slope * sum_x) / count
    return Line(intercept=intercept, slope=slope)
