import ReactECharts from "echarts-for-react";
import * as echarts from "echarts";
import type { ComponentProps } from "react";
import { useThemeStore } from "../store/theme";

/**
 * 统一的图表组件：ECharts 不跟随 antd 的深色算法，坐标轴文字、图例、饼图标签默认都是
 * 深灰色，放在深色底上几乎看不清。这里注册一套只改文字/轴线颜色的深色主题，
 * 不动各图表自己的配色（系列颜色仍由各页面的 option 决定），再按当前皮肤切换。
 *
 * 用注册主题而不是逐个改 option，是为了避免在 3 个页面 12 处图表里重复写同一套文字颜色。
 */
const DARK_TEXT = "#c9ccd3";
const DARK_AXIS = "rgba(255, 255, 255, 0.25)";
const DARK_SPLIT = "rgba(255, 255, 255, 0.12)";

echarts.registerTheme("app-dark", {
  // 背景留透明，让卡片自己的深色背景透出来，避免图表区出现一块突兀的色块
  backgroundColor: "transparent",
  textStyle: { color: DARK_TEXT },
  title: { textStyle: { color: DARK_TEXT } },
  legend: { textStyle: { color: DARK_TEXT } },
  categoryAxis: {
    axisLine: { lineStyle: { color: DARK_AXIS } },
    axisLabel: { color: DARK_TEXT },
    splitLine: { lineStyle: { color: DARK_SPLIT } },
  },
  valueAxis: {
    axisLine: { lineStyle: { color: DARK_AXIS } },
    axisLabel: { color: DARK_TEXT },
    splitLine: { lineStyle: { color: DARK_SPLIT } },
  },
  // 饼图/柱状图上直接标在图形旁边的数值标签
  label: { color: DARK_TEXT },
});

type Props = ComponentProps<typeof ReactECharts>;

export default function Chart(props: Props) {
  const mode = useThemeStore((s) => s.mode);
  // key 跟着皮肤变：ECharts 实例的主题是初始化时定死的，不重建实例切不过去
  return <ReactECharts key={mode} theme={mode === "dark" ? "app-dark" : undefined} {...props} />;
}
