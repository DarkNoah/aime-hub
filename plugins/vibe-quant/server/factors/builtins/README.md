# 内置因子目录 v1

目录共 810 项：WorldQuant Alpha101（101）、国泰君安 Alpha191（191）、Qlib Alpha158（158）、Qlib Alpha360（360）。`formulas.json` 保存原始公式、规范化表达式、输入字段、预热长度和逐条勘误说明。发布版本为确定性 UUID；用户因子不受目录更新影响。

## 来源

2026-10-29 核对以下一手资料；Qlib 取默认特征配置，不包含标签及训练期归一化/去极值处理器。

- [101 Formulaic Alphas，附录 A](https://arxiv.org/pdf/1601.00991)，PDF SHA-256 `1f9c21afe32dcb3ee77b31548acdaea00451fbfa1c0ee10c907867bcc736fce9`。
- [国泰君安《基于短周期价量特征的多因子选股体系》](https://guorn.com/static/upload/file/3/134065454575605.pdf)，表 6 及附录 2，PDF SHA-256 `863f62c2e23bd87ddb42b8338c8fe2b0276d94260ac985e1a0edfff318693c6c`。
- [DolphinDB 官方 GTJA 模块](https://docs.dolphindb.com/zh/modules/gtja191Alpha/src/gtja191Alpha.dos) 的公式注释用于交叉核对，不复用其运算实现。SHA-256 `e3d93adcdacff263795b8f0b97de1b806ce3666b118f7819af59d9ef5ff98543`。
- [Microsoft Qlib 官方特征生成器](https://github.com/microsoft/qlib/blob/main/qlib/contrib/data/loader.py)，取得文件 SHA-256 `814b7f7ab3d418ae3c87ce352220080b239eba2670eac9e38376b794be4075cb`。公式为 `Alpha158DL.get_feature_config()` 与 `Alpha360DL.get_feature_config()` 的输出。

原公式的数学表达式由独立的 `quant_sdk.alpha` 运算器计算。资料归各原作者所有。原文部分公式存在缺参数、拼写或括号问题，已在相关条目的 `notes` 和界面标明采用的解释，尤其 GTJA 54、127、143、146、165、166、181、183。不能声称这些歧义条目是无解释的逐字复现。

## 运算约定

- 行为交易日，列为固定合约池。横截面 rank 采用平均并列名次除以有效个数；没有用单合约的时间排名代替。
- 同一日期任一所选合约缺少必要输入，横截面不计算该日期；不按未来可得性选择存活合约。
- 浮点窗口向下取整；delay 非负；标准差、协方差使用样本自由度 1。`signedpower` 为 sign(x) × abs(x)^a。
- ts_argmax/ts_argmin 是窗口内从旧到新、从 1 开始的位置，重复极值选首个；HIGHDAY/LOWDAY 是距离当前的天数。GTJA WMA 权重按距离当前 0.9^i；DECAYLINEAR 权重由旧到新为 1..n。
- Qlib 算子按官方允许不完整滚动窗口，但因子对外仍等待声明的 lookback 完整后输出；Qlib 的 Rank 是时序百分位。未复用预测标签中的未来 Ref。
- 递推 SMA 在固定的最近 500 根历史中，以第一个有限输入初始化，alpha=m/n、adjust=False。分析和标量调用使用相同切片；不是从任意更早起点开始的无限历史递推。GTJA 143 的 SELF 初值为 1。
- WorldQuant 的 ADV 按论文定义为平均每日成交额，不能替换为平均成交手数。VWAP、成交额、市值、行业分类、基准指数、三因子收益均不得用其他价格代理。当前分析连接器传入 OHLCV 和已有成交额；其余输入可通过 SDK 的 Bar 扩展字段和 evaluate_panel 提供，缺少时明确报错。
- 除零、常数相关系数、无效幂次及不足数据产生缺失值，不变成 0。读取未来数据的表达式被拒绝。
- 策略的 `value()` 仅适用于时序因子。横截面因子用 `evaluate_panel`；宿主因子分析自动调用此入口。切换合约池会改变结果。

## 验证

`tests/test_alpha_library.py` 遍历全部公式并校验元数据，另以独立算术验证代表公式、排名/成交额/权重口径、时间因果性、固定合约池、缺字段报错和标量/面板一致性。`tests/factor-groups.test.ts` 覆盖目录与版本 ID，并提供真实 ClickHouse 的分组 CRUD、并发冲突、受保护组、旧因子归类和内置分析集成测试。

这些检查不代表所有公式已与第三方平台进行全历史逐点比对，也不代表实际市场收益。
