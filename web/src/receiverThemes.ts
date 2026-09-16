export const receiverThemes = [
  { id: "walnut", name: "胡桃木", description: "温暖的模拟时光" },
  { id: "vitreous", name: "琉璃夜色", description: "青紫光影，玻璃质感" },
  { id: "led", name: "光阵立方", description: "三面 LED，点亮声音" },
  { id: "soft", name: "云白拟态", description: "轻柔机身，圆形调谐" },
  { id: "arc", name: "弧光调谐", description: "弧形刻度，石墨面板" },
  { id: "ivory", name: "奶油白", description: "细孔扬声器，数码显示窗" },
  { id: "mono", name: "黑白刻度", description: "黑白留白，一抹红色" },
  { id: "retro", name: "银色复古", description: "金属转盘，橙色开关" },
  { id: "signal", name: "红屏像素", description: "珊瑚红屏，像素读数" },
] as const;
export type ReceiverTheme = (typeof receiverThemes)[number]["id"];
export function isReceiverTheme(value: string | null): value is ReceiverTheme {
  return receiverThemes.some((theme) => theme.id === value);
}
