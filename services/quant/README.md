# services/quant — Python quant service

Lands in **Phase 3**.

Feature computation, pattern detection, forward labeling (R-multiple, MAE, MFE),
backtesting, walk-forward validation, Monte Carlo, and regime classification.

Python rather than TypeScript deliberately: getting a backtester subtly wrong is
worse than operating two languages, and numpy/pandas/scipy/statsmodels do this
work correctly out of the box.

Connects as `vesti_backtest`, which holds **no table grants** — data comes only
through the `pit_*` functions, so reading the future is a permission the role
does not have.
