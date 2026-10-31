/**
 * 分享卡片右下角的下载二维码（用户 m10523）。
 *
 * URL 是固定的（官网下载页），所以矩阵在编译期就定死：不引第三方 QR 库、
 * 不在运行时算，几百字节的常量换来零依赖 —— 卡片绘制那条路（ShareCardPanel）
 * 本来就不带任何图形依赖，加个 QR 编码器进去不值当。
 *
 * **改 URL 要重新生成矩阵**（`pip install segno` 后跑）：
 *
 * ```py
 * import segno
 * qr = segno.make_qr("https://quietmusic.canace.cn/download", error="m")
 * print(qr.version, len(qr.matrix))
 * print("\n".join("".join("1" if v else "0" for v in row) for row in qr.matrix))
 * ```
 *
 * 当前矩阵：version 3、纠错 M（29×29，含 36 字符 URL 绰绰有余；Q 级会涨到
 * version 4 的 33×33，同一块地方每格更小反而更难扫，故取 M）。
 */

/** 二维码指向的地址：官网下载页 */
export const SHARE_QR_URL = "https://quietmusic.canace.cn/download";

/** 符号边长（模块数，不含安静区） */
export const SHARE_QR_MODULES = 29;

/** 安静区宽度（模块数）：QR 标准要求四周至少 4 格，少了扫码率会掉 */
export const SHARE_QR_QUIET = 4;

/**
 * 29×29 矩阵，`1` = 深色模块。固定黑白色，**不跟主题走** —— 深色主题下若把
 * 深模块画成主题的浅色、底画成卡片底色，对比度一低就扫不出来。
 */
export const SHARE_QR_MATRIX: readonly string[] = [
  "11111110100001100110011111111",
  "10000010100111111101001000001",
  "10111010010110101001001011101",
  "10111010000101010010001011101",
  "10111010110010110011001011101",
  "10000010001011011001101000001",
  "11111110101010101010101111111",
  "00000000000111001111000000000",
  "10101010010010111100100010010",
  "10100000000110001100101001001",
  "10011111100001001000011110111",
  "00110100101100011110010000010",
  "11110011101000011110111001011",
  "01010101001101001000111001001",
  "01111011010000101100110111011",
  "01010001110001101100100111010",
  "01100110100010111101111001011",
  "01001001001110101100001001101",
  "10001010000011000110011110011",
  "01111000010010001110000001010",
  "10011010101100000100111110000",
  "00000000101111001001100010111",
  "11111110011100100101101011011",
  "10000010001111101100100011000",
  "10111010101100111110111110011",
  "10111010010110101000000010111",
  "10111010101010001100010111001",
  "10000010001101011111110000010",
  "11111110100011101101110011011",
];

/** 二维码深色模块的颜色（纯黑，给足对比度） */
const QR_DARK = "#000000";

/** 二维码底色：恒为白，深色主题下也不改 */
const QR_LIGHT = "#ffffff";

/**
 * 在画布上画二维码。
 *
 * @param ctx   画布上下文（已按导出倍率缩放好）
 * @param x     方块左上角 x
 * @param y     方块左上角 y
 * @param block 方块边长（**含**四周安静区）
 *
 * 调用方只需要给方块和位置，安静区、格子尺寸都由这里算 —— 免得每个调用点
 * 各自 `+ 4 格` 一遍，改个尺寸就对不上。
 */
export function drawShareQr(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  block: number,
): void {
  const cells = SHARE_QR_MODULES + SHARE_QR_QUIET * 2;
  const cell = block / cells;

  ctx.save();
  // 先铺白底：安静区靠它，浅色卡片上也是这层白把二维码和内容隔开
  ctx.fillStyle = QR_LIGHT;
  ctx.fillRect(x, y, block, block);

  ctx.fillStyle = QR_DARK;
  for (let row = 0; row < SHARE_QR_MODULES; row += 1) {
    const line = SHARE_QR_MATRIX[row];
    for (let col = 0; col < SHARE_QR_MODULES; col += 1) {
      if (line[col] !== "1") continue;
      // 相邻深模块共边即可，不做 +1 像素肥化：格子本来就小，肥化会把白色
      // 间隔吃掉一半，反而更难扫
      ctx.fillRect(
        x + (col + SHARE_QR_QUIET) * cell,
        y + (row + SHARE_QR_QUIET) * cell,
        cell,
        cell,
      );
    }
  }
  ctx.restore();
}
