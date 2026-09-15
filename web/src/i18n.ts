import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import english from "./i18n-ui-en";
import timerEnglish from "./i18n-timer-en";
function savedLanguage() {
  try {
    return localStorage.getItem("meow-language") === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}
void i18n.use(initReactI18next).init({
  lng: savedLanguage(),
  fallbackLng: "zh",
  supportedLngs: ["zh", "en"],
  keySeparator: false,
  nsSeparator: false,
  resources: {
    zh: { translation: {} },
    en: {
      translation: {
        ...english,
        ...timerEnglish,
        "{{count}} 小时_one": "{{count}} hour",
        "{{count}} 小时_other": "{{count}} hours",
        "{{count}} 分钟_one": "{{count}} minute",
        "{{count}} 分钟_other": "{{count}} minutes",
        "请求失败，请稍后重试": "Request failed. Please try again.",
        "账号已切换，请重新操作收藏":
          "Account changed. Please repeat the preset action.",
      },
    },
  },
  interpolation: { escapeValue: false },
  returnEmptyString: false,
});
export function tr(key: string, options?: Record<string, unknown>): string {
  return String(i18n.t(key, options || {}));
}
export function setLanguage(language: "zh" | "en") {
  try {
    localStorage.setItem("meow-language", language);
  } catch {
    /* storage unavailable */
  }
  void i18n.changeLanguage(language);
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
}
document.documentElement.lang = i18n.language === "en" ? "en" : "zh-CN";
export default i18n;
