# meowRadio receiver
The UI/UX search matched Skeuomorphism (styles.csv). The aggregate marketing/Swiss result was not appropriate and is not used.
Walnut enclosure, warm aluminum panel, inset amber LCD, woven speaker grille. Background #eeeae3, foreground #302e29, secondary text #686258, action #a6452c, display #edcf88 on #292a23. System sans serif and monospace display fonts: offline, no font requests.
Use Radix Dialog for focus management. Buttons >=44px, visible keyboard focus, labels for every control. Press feedback scale .97 for 120ms cubic-bezier(.23,1,.32,1); keyboard and reduced-motion interactions have no motion. No decorative perpetual animation or fake equalizer. Real playback state controls the on-air indicator. Station ticks are indices, never simulated MHz.

## Additional user-specified themes
Vitreous: cyan/violet ambient light, glass panel, Outfit and Space Mono bundled locally, circular play key. LED: scoped 9×9×3 CSS cube, cyan/magenta/ice faces, 2D/3D controls, bounded stage/floor light. Both preserve the existing audio element and real playback state. Decorative visuals stop when paused or under reduced motion; controls remain keyboard operable. Theme/view preferences live in localStorage.

Cloud-white / soft: Oleksandr Plyuto for heartbeat, Dribbble shot 11629433. Ice-blue white chassis, low-saturation green inset circular station-index display, radial ticks, soft light/shadow elevation, ribbed functional tuner slider and volume control. Use readable slate text, green action accent, standard keyboard-operable range inputs. Responsive hardware layout reduces to tuner and level units on mobile. No Braun branding, fake MHz or decorative EQ controls.

## User-confirmed restraint
Brand: 阿喵收音机 (meowRadio technical identifier), original logo from issue #1. Login is a standalone /login page. Home exposes only search + one filter entry; never place the full filter form or lists of facets on home. Show only the active count on the trigger. Use a focus-trapped dialog / mobile bottom sheet with Apply/Reset and discard uncommitted edits on close. Country/language/type/sort are inside; audio refinements stay collapsed.

## Appearance and timed shutdown
Chinese/English language and light/dark color mode are independent controls in the home header. All four skins have both palettes; material and accent follow the skin. Sleep timer is a clock with two draggable hands, numeric/keyboard alternatives, and a single main-view entry. Final countdown emphasis appears only at its configured threshold, uses stable tabular digits and a gentle decorative halo, and is static for reduced-motion users. No repeated screen-reader announcement each second.


## v0.1.2 交互修订

首页顶栏提供中文/English 和浅色/暗色快捷切换，设置保留四种收音机外观、连接方式与版本。首页导航保留音频实例与当前筛选；浏览状态、页码及默认中转方式保存在本浏览器。HTTP HLS 可通过认证中转播放，所有子资源维持签名与公共目的地址检查。

宣传文字使用 TransientCopy：首次进入可见区域淡入 180ms、停留 1.5 秒、淡出 200ms，保留布局位置，重渲染不重复；减少动态效果时缩短透明度过渡。功能说明、错误与播放状态不自动隐藏。四种外观使用播放状态动效，仅实际播放且页面可见、音量非零时运动，不伪造频谱。LazyCat 控制栏能力仅在受支持 WebShell 环境启用。


## v0.2.0 confirmed behavior

Nine receiver skins; each new skin has a separate stylesheet. User menu: Personal options, System settings, Recordings, Sign out. Personal options has exactly Profile (nickname/avatar) and Change password tabs. System settings keeps Themes and Settings tabs with playback/recording preferences, proxy diagnostic and version. Recording management is a separate dialog. Temporary station/server playback does not change the saved default; current relay is controlled with an icon-only toggle and accessible tooltip.

Recordings are captured from same-origin relayed audio and uploaded under record/<username>/UUID; avatar files use avatar/<username>.webp. Owners are authenticated per request and upload identity is checked against captured owner. Stopping/changing station saves the previous segment; resume never automatically restarts recording. Stream recovery uses bounded backoff and respects pause, library playback and absolute sleep deadline.
