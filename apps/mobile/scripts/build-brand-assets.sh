#!/usr/bin/env bash
#
# 从品牌母图产出全套图标与启动图（F14-04）。
#
# 为什么要有这个脚本：图标不是一个文件，而是一族（Android 六个密度 × 三种图 +
# 启动图 + Web 图标）。手改一次容易，但要保证"改母图后全族一起变、且尺寸对得上"
# 就只能靠脚本。母图改了重跑本脚本即可。
#
# 母图：docs/brand/icon-master-1024.png（卡通厨房场景：戴厨师帽的陶锅 + 挂锅 + 一摞碗 +
#       番茄/胡萝卜/大葱，AI 生成后经用户从四版动画风候选里选定 D）。上一版"手绘水粉房子"
#       归档在 history/brand/2026-10-14-icon-master-house-1024.png，要回退把它换回
#       icon-master-1024.png 即可（注意尺寸参数是按本图重量的，换回去要重算）
#
# 关键约束（改脚本前先读）：
#  1. **图标风格由 ICON_STYLE 决定**（sticker / adaptive），两者产出不同的资源，
#     默认 sticker。换风格要重跑本脚本，别手改 res 下的文件。
#  2. **抠底只能删掉与边缘连通的背景**。母图里被自身轮廓围起来的元素
#     （本图的蒸汽）会留下轮廓碎片与内部底色，叠在深色启动器上像污点——
#     故有一道连通域过滤（clean-icon-blobs.py + BLOB_MIN_PX）。见那一节的注释。
#  3. 米色 #FCF1DA 是三处共用的值：本脚本 / values/splash-colors.xml / 前端
#     color-cream（启动窗口与首屏要同色才看不到接缝）。换色要三处一起改。
#  4. drawable*/splash.png 是 Capacitor 遗留资源：本项目 styles.xml 已把
#     windowSplashScreenAnimatedIcon 指到 @mipmap/ic_launcher，所以
#     **Android 12+ 真正显示的启动图标就是启动器图标本身**。这里仍重画
#     它们，只为把默认的蓝色 X 素材从包里清掉。
#
# 用法：bash apps/mobile/scripts/build-brand-assets.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MASTER="$REPO_ROOT/docs/brand/icon-master-1024.png"
ASSETS="$REPO_ROOT/apps/mobile/assets"
RES="$REPO_ROOT/apps/mobile/android/app/src/main/res"

# --- 图标风格（用户 2026-10-14 选定 sticker）---
# sticker  = 贴纸式：只有画面本身、外轮廓不规则、四周透明（用户要的）
# adaptive = 自适应图标：启动器套形（圆/方圆），画面坐落在米色底盘上（上一版）
# 两者产出的资源不同，切换后重跑本脚本即可；实测差异与限制见 R-060。
ICON_STYLE="${ICON_STYLE:-sticker}"

# --- 参数 ---
CREAM="#FCF1DA"        # 品牌米色（= 前端 color-cream = splashBackground）
BLOB_MIN_PX=1000       # 抠图后保留的连通域最小面积（px）。实测本母图真元素只有三个：
                       # 主体 440589 / 平底锅 63665 / 爱心 2313，其余 298 个碎片合计 615px
                       # （陶锅上方蒸汽的轮廓与内部，被自身封闭曲线围住、floodfill 抠不掉）。
                       # 1000 能干净切开。**换母图要重新确认**：若新图有小巧但真实的元素
                       # （星星、圆点），会被一起丢掉，届时调小该值或改用 bbox 白名单。
KEY_FUZZ=12            # 抠底容差（%）：母图底色不是纯色，实测 8% 抠不净、20% 吃边缘；
                       # 本母图背景很均匀（四角都是 251,238,207），10% 起结果就稳定
DP=1024                # 源图画布边长（px），对应自适应图标 108dp
# 画面高度占「贴纸图标」的比例（%）。sticker 风格下这就是**图标本体的大小**，
# 四周全透明；81% 让画面离画布边留一点余量，避免被某些启动器/系统裁掉边缘。
# （它和 @capacitor/assets 生成的传统图标是同一条路径，故共用一个变量。）
FG_ART_DP=80           # **仅 ICON_STYLE=adaptive 时使用**：自适应前景里画面的显示高度。
                       # 想让画面铺满图标（去掉那圈背景色）就得让前景短边 ≥ 可见区 72dp：
                       # 本母图 869×903，高 80dp 时宽 = 80×869/903 ≈ 77dp > 72dp，四角有余量。
                       # sticker 风格不走这里（它删掉自适应图标、直接用 icon-only.png）。
# 场景在贴纸图标画布里的占比（%）。sticker 与 adaptive 两种风格共用这一个变量：
#  - sticker：**这就是图标本身的大小**，81% 让画面四周留一点呼吸位；
#  - adaptive：要与自适应图标看起来一样大，按 (FG_ART_DP/108) × 192/176 反推。
LEGACY_ART_RATIO=81    # 传统方形图标里场景占源图的比例（%）。
                       # 目标同样是"与自适应图标看起来一样大"。自适应里场景占
                       # 80/108 = 74.1% 的图标位；@capacitor/assets 生成传统图标会再内缩
                       # 8px（192px 档缩到 176px 再居中），所以要 74.1% × 192/176 = 80.8%
                       # → 取 81%。传统图标只在 API 24/25 上生效（minSdk 24）
SPLASH_ART_DP=150      # 启动图里场景高度（dp）

[ -f "$MASTER" ] || { echo "找不到母图：$MASTER" >&2; exit 1; }
command -v magick >/dev/null || { echo "需要 ImageMagick（magick）" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== 1/5 从母图抠出透明底的画面 =="
magick "$MASTER" -fuzz "${KEY_FUZZ}%" -fill none -draw 'alpha 0,0 floodfill' "$TMP/art-keyed.png"
# 去掉抠图残渣（蒸汽等被自身轮廓围住的元素，floodfill 碰不到）。
# 细节与阈值依据见 scripts/clean-icon-blobs.py 的文档注释。
python3 "$REPO_ROOT/apps/mobile/scripts/clean-icon-blobs.py" \
  "$TMP/art-keyed.png" "$TMP/art-clean.png" "$BLOB_MIN_PX" | sed 's/^/   /'
# 裁到实际内容，后面按高度统一缩放（母图四周留白很多）
magick "$TMP/art-clean.png" -trim +repage "$TMP/art.png"
read -r ART_W ART_H <<<"$(magick "$TMP/art.png" -format '%w %h' info:)"
echo "   画面内容框 ${ART_W}x${ART_H}px"

# 把房子按「目标高度 px」等比缩放后居中放到方画布上
place_art() { # $1=输出 $2=画布边长 $3=房子高度
  local out="$1" canvas="$2" h="$3" w
  w=$(( ART_W * h / ART_H ))
  magick "$TMP/art.png" -resize "${w}x${h}!" \
    -background none -gravity center -extent "${canvas}x${canvas}" "$out"
}

echo "== 2/5 产出 assets/ 三张源图（交给 @capacitor/assets）=="
mkdir -p "$ASSETS"

# 前景层：透明底，房子高 FG_ART_DP（源图 px = dp × 1024/108）
FG_H=$(( DP * FG_ART_DP / 108 ))
place_art "$ASSETS/icon-foreground.png" "$DP" "$FG_H"
echo "   前景层：画面 ${FG_H}px / ${DP}px 画布 = 显示 ${FG_ART_DP}dp（可见框 72dp 的 $(( FG_ART_DP * 100 / 72 ))%）"

# 传统方形图标（无内缩，整块就是图标），房子占 LEGACY_ART_RATIO%
LEG_H=$(( DP * LEGACY_ART_RATIO / 100 ))
place_art "$TMP/legacy-art.png" "$DP" "$LEG_H"
# 【实验B】传统图标走透明底（贴纸式）：不加米色底
cp "$TMP/legacy-art.png" "$ASSETS/icon-only.png"
echo "   传统图标：画面 ${LEG_H}px / ${DP}px（${LEGACY_ART_RATIO}%）"

# 背景层：米色。
# ⚠️ **不要把它改成透明**去追求"没有背景色"：实测（Android 16 模拟器）背景层全透明
# 时 App info 里会渲染成一个**黑圈**（生成的 PNG 本身 alpha=0 是对的，问题出在系统侧
# 的合成）。要去掉"外面那层背景"应该靠**把场景放大到铺满图标**（见 FG_ART_DP），
# 而不是把背景层抽掉——前景铺满时这层本来就看不见。
magick -size "${DP}x${DP}" "xc:$CREAM" "$ASSETS/icon-background.png"

echo "== 3/5 调 @capacitor/assets 生成 Android 图标 =="
cd "$REPO_ROOT/apps/mobile"
npx --yes @capacitor/assets@3 generate \
  --android \
  --iconBackgroundColor "$CREAM" \
  --iconBackgroundColorDark "$CREAM" 2>&1 | sed 's/^/   /'

echo "== 4/5 启动图（11 张，等比不拉伸）=="
splash_one() { # $1=输出 $2=宽 $3=高
  local out="$1" w="$2" h="$3" hs ws
  hs=$(( h * SPLASH_ART_DP / 480 ))   # 各密度都以「480dp 高的整屏」为基准折算
  ws=$(( ART_W * hs / ART_H ))
  magick -size "${w}x${h}" "xc:$CREAM" \
    \( "$TMP/art.png" -resize "${ws}x${hs}!" \) \
    -gravity center -composite "$out"
}
splash_one "$RES/drawable/splash.png" 480 320
# 每条 = 密度:宽:高
for spec in \
  mdpi:320:480 hdpi:480:800 xhdpi:720:1280 xxhdpi:960:1600 xxxhdpi:1280:1920 \
  land-mdpi:480:320 land-hdpi:800:480 land-xhdpi:1280:720 \
  land-xxhdpi:1600:960 land-xxxhdpi:1920:1280; do
  den="$(echo "$spec" | cut -d: -f1)"; w="$(echo "$spec" | cut -d: -f2)"; h="$(echo "$spec" | cut -d: -f3)"
  case "$den" in
    land-*) splash_one "$RES/drawable-${den}/splash.png" "$w" "$h" ;;
    *)      splash_one "$RES/drawable-port-${den}/splash.png" "$w" "$h" ;;
  esac
done
echo "   已重画 $(find "$RES" -name splash.png | wc -l | tr -d ' ') 张"

echo "== 5/6 Web 图标（favicon / apple-touch）=="
PUBLIC="$REPO_ROOT/apps/mobile/public"
# 位图版：直接缩母图。**这两张刻意保留米色底**，与前两项相反：
#  - apple-touch-icon 若带透明，iOS 会用**黑色**填透明区，在浅色图标上非常难看；
#  - favicon 在深色浏览器主题下若透出深色底，这套暖色插画会糊成一团。
# 启动器图标可以透明是因为 Android 启动器会给图标画在自己算好的底上，Web 这边没有这层。
magick "$ASSETS/icon-only.png" -background "$CREAM" -flatten -resize 64x64 "$PUBLIC/favicon.png"
magick "$ASSETS/icon-only.png" -background "$CREAM" -flatten -resize 180x180 "$PUBLIC/apple-touch-icon.png"
# 为什么没有矢量版 favicon：上一版母图是个"只有五个几何块"的小房子，还能把外轮廓
# 逐行量出来用 path 重画；现在这个场景（陶锅 + 挂锅 + 一摞碗 + 三样菜 + 木托盘）细节太多，
# 手描不现实、自动描摹（potrace 等）本机没有且对水彩笔触效果很差，所以只出位图。
# favicon 实际就渲染在 16~32px，位图在这个尺寸上本来就比描摹图干净。
echo "   已写 public/favicon.png(64) / apple-touch-icon.png(180)"

echo "== 6/6 图标风格：$ICON_STYLE =="
if [ "$ICON_STYLE" = "sticker" ]; then
  # 贴纸式：不要自适应图标，改走透明位图（只有画面本身、外轮廓不规则）。
  #
  # ⚠️ **这一步必须放在 @capacitor/assets 之后**：那个工具每次都会重新生成
  #    mipmap-anydpi-v26/ic_launcher.xml，而自适应图标会被 Android **强制套上
  #    启动器形状**（圆/方圆，随启动器与设置变化），永远得不到不规则轮廓。
  #    （我第一次「手工移开 XML」的实验就是被它重新生成盖掉的，白测一轮。）
  rm -f "$RES/mipmap-anydpi-v26/ic_launcher.xml"
  rm -f "$RES/mipmap-anydpi-v26/ic_launcher_round.xml"
  # 连带清掉空目录（git 不跟踪空目录，留着只会让每次构建后目录树有噪音）
  rmdir "$RES/mipmap-anydpi-v26" 2>/dev/null || true
  # roundIcon 那张本来是"画个圆把画面裁进去"，圆外透明——在贴纸目标下它等于强行
  # 给了一个圆。换成与 ic_launcher.png 同一张，启动器不管取哪个资源拿到的都是贴纸。
  for d in ldpi mdpi hdpi xhdpi xxhdpi xxxhdpi; do
    cp "$RES/mipmap-$d/ic_launcher.png" "$RES/mipmap-$d/ic_launcher_round.png"
  done
  echo "   已删自适应 XML、round 与主图标统一为透明贴纸"
  echo "   ⚠️ 是否真显示成不规则，取决于启动器：Pixel Launcher 会给 legacy 图标"
  echo "      自垫一个浅色圆底；部分第三方/国产 OEM 启动器会原样显示透明 PNG。"
else
  echo "   保留自适应图标（启动器套形 + 米色底盘）"
fi
# 默认模板的白色 X 前景矢量（已无人引用）一并清掉
rm -f "$RES/drawable-v24/ic_launcher_foreground.xml"
rm -f "$RES/drawable/ic_launcher_background.xml"

echo
echo "完成。产物："
echo "  assets/icon-{only,foreground,background}.png      （源图，入库）"
echo "  android/.../mipmap-*/ic_launcher{,_round,_foreground,_background}.png"
echo "  android/.../mipmap-anydpi-v26/ic_launcher{,_round}.xml"
echo "  android/.../drawable*/splash.png"
echo "  public/favicon.png + apple-touch-icon.png"
echo
echo "改母图后重跑本脚本即可全族同步；之后用 pnpm run build:apk 出包装机复核。"
