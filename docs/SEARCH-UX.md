# Search UX follow-up

Review scope: Chinese composition input, FM-name/frequency queries, filtering, pending state, recovery from empty results. This extends the initial application implementation.

| Before | After | Why |
| --- | --- | --- |
| Every input change searches after 350 ms, including incomplete IME text | Debounce starts after composition ends; Enter cannot prematurely submit composing text | Avoids sending intermediate pinyin and flashing irrelevant results |
| No explicit submit action | Enter or the search button submits immediately; pending debounce is cancelled | Clear keyboard and touch feedback without duplicate delayed resets |
| `ＦＭ １０４．２ MHz` is passed literally | NFKC normalization and conventional standalone FM frequency syntax become `104.2` | Matches the frequency text recorded in station names; does not imply RF scanning |
| Changing a query replaces results with skeletons | Prior results remain while a live status explicitly says they are previous results | Keeps layout stable and makes pending work visible |
| Filters can silently make a valid term look absent | A compact filter entry opens a draft form with Apply/Reset, plus an empty-state clear-filter action | Helps users recover without guessing which filter caused the empty state |
| Empty favorites search has only generic copy | Offers continuing the same query in all stations | Avoids a dead end |
| Escape can interfere with IME | Escape clears only outside composition | Preserves normal Chinese input cancellation |

Standalone filtering: full country/language/type directory loads only after opening the filter entry. Draft edits do not change the list until Apply; closing discards them. No keyword is required. Home contains no filter fields.

Validation: six dedicated search tests cover normalization, debounce, composition, immediate submit, clear cancellation, and external reset. Existing six playback tests continue to verify uninterrupted playback across all four themes. The service still searches Radio Browser directory entries; terrestrial-only FM without an internet stream is outside its scope.


## v0.1.2 交互修订

首页顶栏提供中文/English 和浅色/暗色快捷切换，设置保留四种收音机外观、连接方式与版本。首页导航保留音频实例与当前筛选；浏览状态、页码及默认中转方式保存在本浏览器。HTTP HLS 可通过认证中转播放，所有子资源维持签名与公共目的地址检查。

宣传文字使用 TransientCopy：首次进入可见区域淡入 180ms、停留 1.5 秒、淡出 200ms，保留布局位置，重渲染不重复；减少动态效果时缩短透明度过渡。功能说明、错误与播放状态不自动隐藏。四种外观使用播放状态动效，仅实际播放且页面可见、音量非零时运动，不伪造频谱。LazyCat 控制栏能力仅在受支持 WebShell 环境启用。
