#!/usr/bin/env bash
#
# 从品牌母图产出全套图标与启动图（F14-04）。
#
# 为什么要有这个脚本：图标不是一个文件，而是一族（Android 五个密度 × 三种图 +
# 自适应图标 XML + 启动图 + Web favicon）。手改一次容易，但要保证"改母图后
# 全族一起变、且尺寸对得上"就只能靠脚本。母图改了重跑本脚本即可。
#
# 母图：docs/brand/icon-master-1024.png（卡通厨房场景：戴厨师帽的陶锅 + 挂锅 + 一摞碗 +
#       番茄/胡萝卜/大葱，AI 生成后经用户从四版动画风候选里选定 D）。上一版"手绘水粉房子"
#       归档在 history/brand/2026-10-14-icon-master-house-1024.png，要回退把它换回
#       icon-master-1024.png 即可
#       （但注意 FG_ART_DP 那组尺寸是按本图重量的，换回去要按注释重算）
#
# 关键约束（改脚本前先读）：
#  1. 自适应图标的 Android 契约：画布 108dp，系统对源图**四边各内缩 16.7%**，
#     可见区 = 108 × (1 - 2×0.167) ≈ 72dp，安全圈 66dp。源图 1024px 对应 108dp，
#     所以「房子在源图里多少 px」直接等于「显示多少 dp × 1024/108」，与内缩无关
#     （内缩只是裁，不缩放）。见 FG_ART_DP。
#  2. 前景源图必须是**透明底**：它叠在背景层上，带底色会露出一个方块。
#     母图是米色底的水粉画，故先按底色抠出 alpha（见 KEY_FUZZ）。
#  3. 背景层是纯米色 #FCF1DA，与启动窗口、首屏同色——换色必须三处一起改
#     （本脚本 / values/splash-colors.xml / 前端 color-cream）。
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

# --- 参数 ---
CREAM="#FCF1DA"        # 品牌米色（= 前端 color-cream = splashBackground）
KEY_FUZZ=12            # 抠底容差（%）：母图底色不是纯色，实测 8% 抠不净、20% 吃边缘；
                       # 本母图背景很均匀（四角都是 251,238,207），10% 起结果就稳定
DP=1024                # 源图画布边长（px），对应自适应图标 108dp
FG_ART_DP=52           # 自适应前景里**场景**的显示高度（dp）。本母图是近方形构图
                       # （内容框 869×903，宽高比 0.96），塞进圆形遮罩时四个角最先被切，
                       # 所以这个值比上一版房子母图（62dp）小得多。实测「艺术像素落在
                       # 66dp 安全圈外」的比例：52dp→0%、54dp→0.11%、56dp→1.03%、
                       # 58dp→2.62%。取 52dp 是**仍然 0% 被切的上限**
LEGACY_ART_RATIO=53    # 传统方形图标里场景占源图的比例（%）。
                       # 目标同样是"与自适应图标看起来一样大"。自适应里场景占
                       # 52/108 = 48.1% 的图标位；@capacitor/assets 生成传统图标会再内缩
                       # 8px（192px 档缩到 176px 再居中），所以要 48.1% × 192/176 = 52.5%
                       # → 取 53%。传统图标只在 API 24/25 上生效（minSdk 24）
SPLASH_ART_DP=150      # 启动图里场景高度（dp）

[ -f "$MASTER" ] || { echo "找不到母图：$MASTER" >&2; exit 1; }
command -v magick >/dev/null || { echo "需要 ImageMagick（magick）" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== 1/5 从母图抠出透明底的房子 =="
magick "$MASTER" -fuzz "${KEY_FUZZ}%" -fill none -draw 'alpha 0,0 floodfill' "$TMP/art-full.png"
# 裁到实际内容，后面按高度统一缩放（母图四周留白很多）
magick "$TMP/art-full.png" -trim +repage "$TMP/art.png"
read -r ART_W ART_H <<<"$(magick "$TMP/art.png" -format '%w %h' info:)"
echo "   房子内容框 ${ART_W}x${ART_H}px"

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
echo "   前景层：房子 ${FG_H}px / ${DP}px 画布 = 显示 ${FG_ART_DP}dp（可见框 72dp 的 $(( FG_ART_DP * 100 / 72 ))%）"

# 传统方形图标（无内缩，整块就是图标），房子占 LEGACY_ART_RATIO%
LEG_H=$(( DP * LEGACY_ART_RATIO / 100 ))
place_art "$TMP/legacy-art.png" "$DP" "$LEG_H"
magick "$TMP/legacy-art.png" -background "$CREAM" -flatten "$ASSETS/icon-only.png"
echo "   传统图标：房子 ${LEG_H}px / ${DP}px（${LEGACY_ART_RATIO}%）"

# 背景层：纯米色，铺满
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
# 位图版：直接缩母图，与启动器图标同一张观感
magick "$ASSETS/icon-only.png" -resize 64x64 "$PUBLIC/favicon.png"
magick "$ASSETS/icon-only.png" -resize 180x180 "$PUBLIC/apple-touch-icon.png"
# 为什么没有矢量版 favicon：上一版母图是个"只有五个几何块"的小房子，还能把外轮廓
# 逐行量出来用 path 重画；现在这个场景（陶锅 + 挂锅 + 一摞碗 + 三样菜 + 木托盘）细节太多，
# 手描不现实、自动描摹（potrace 等）本机没有且对水彩笔触效果很差，所以只出位图。
# favicon 实际就渲染在 16~32px，位图在这个尺寸上本来就比描摹图干净。
echo "   已写 public/favicon.png(64) / apple-touch-icon.png(180)"

echo "== 6/6 清掉遗留的默认矢量素材 =="
# 默认模板的白色 X 前景矢量：新自适应图标用的是 @mipmap/ic_launcher_foreground，
# 这个 drawable 已无人引用（全仓 grep 无 @drawable/ic_launcher_foreground），留着只会让人看错
rm -f "$RES/drawable-v24/ic_launcher_foreground.xml"
rm -f "$RES/drawable/ic_launcher_background.xml"
echo "   已删 drawable-v24/ic_launcher_foreground.xml 与 drawable/ic_launcher_background.xml"

echo
echo "完成。产物："
echo "  assets/icon-{only,foreground,background}.png      （源图，入库）"
echo "  android/.../mipmap-*/ic_launcher{,_round,_foreground,_background}.png"
echo "  android/.../mipmap-anydpi-v26/ic_launcher{,_round}.xml"
echo "  android/.../drawable*/splash.png"
echo "  public/favicon.png + apple-touch-icon.png"
echo
echo "改母图后重跑本脚本即可全族同步；之后用 pnpm run build:apk 出包装机复核。"
