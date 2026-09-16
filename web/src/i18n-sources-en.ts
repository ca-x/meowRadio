const sourcesEnglish: Record<string, string> = {
  清理请求读取超时: "Timed out while reading the cleanup request.",
  "此源没有播放地址，无需检测。":
    "This source has no playback addresses to check.",
  "个人电台源 · 阿喵收音机": "Personal sources · Meow Radio",
  "请选择 JSON 文件": "Choose a JSON file",
  个人电台源: "Personal sources",
  "按账号保存订阅、电台与备用线路。":
    "Save sources, stations, and backup streams to your account.",
  格式说明: "Format guide",
  添加电台源: "Add source",
  "服务端尚未安装 FFmpeg。可以先导入，安装并重启服务后即可播放个人源。":
    "FFmpeg is not installed on the server. You can import sources now. Install FFmpeg and restart the server to play them.",
  "正在加载电台源…": "Loading sources…",
  还没有个人电台源: "No personal sources yet",
  "填写网络地址，或上传包含电台列表的 JSON 文件。":
    "Enter a URL or upload a JSON file containing a station list.",
  "{{sources}} 个源 · {{stations}} 个电台":
    "Sources: {{sources}} · Stations: {{stations}}",
  全部删除: "Delete all",
  网络地址: "URL",
  上传文件: "Upload file",
  "{{count}} 个电台": "Stations: {{count}}",
  "{{count}} 个电台_one": "{{count}} station",
  "{{count}} 个电台_other": "{{count}} stations",
  "检测 {{name}}": "Check {{name}}",
  检查地址: "Check URLs",
  "更新 {{name}}": "Update {{name}}",
  更新: "Update",
  "删除电台源 {{name}}": "Delete source {{name}}",
  搜索此源电台: "Search stations in this source",
  未分类: "Uncategorized",
  "删除个人电台 {{name}}": "Delete personal station {{name}}",
  "第 {{page}} / {{pages}} 页 · {{count}} 个电台":
    "Page {{page}} / {{pages}} · Stations: {{count}}",
  "第 {{page}} / {{pages}} 页 · {{count}} 个电台_one":
    "Page {{page}} / {{pages}} · {{count}} station",
  "第 {{page}} / {{pages}} 页 · {{count}} 个电台_other":
    "Page {{page}} / {{pages}} · {{count}} stations",
  更新文件源: "Update file source",
  "导入后只对当前账号可见。更新成功后保留仍存在电台的收藏。":
    "Imported sources are only visible to your account. After an update, stations that remain in the source keep their favorites.",
  源名称: "Source name",
  导入方式: "Import method",
  订阅或电台地址: "Source or station URL",
  "支持 JSON 订阅地址、单个音频地址或电台播放页。":
    "Use a JSON source URL, a single audio URL, or a station's playback page.",
  "选择 JSON 文件": "Choose JSON file",
  "单个文件最多 5 MiB、5000 个电台。":
    "Each file can contain up to 5,000 stations and must not exceed 5 MiB.",
  "正在导入…": "Importing…",
  导入: "Import",
  删除个人源内容: "Delete personal source content",
  "删除所有个人电台源及对应收藏？系统电台收藏不受影响。":
    "Delete all personal sources and their favorites? System station favorites will be kept.",
  "删除 {{name}} 及其对应收藏？此操作无法撤销。":
    "Delete {{name}} and its favorites? This cannot be undone.",
  发现无效播放地址: "Invalid stream URLs found",
  "以下地址格式无效。清除后继续导入，其余有效备用地址和对应收藏会保留。":
    "The URLs below have an invalid format. Remove them to continue importing. Valid backup URLs and their station favorites will be kept.",
  "第 {{number}} 个电台": "Station {{number}}",
  "线路 {{number}}": "Stream {{number}}",
  "清理后保留 {{count}} 个电台；没有有效地址的电台及对应收藏会移除。":
    "Stations remaining after cleanup: {{count}}. Stations with no valid URLs and their favorites will be removed.",
  清除无效地址并继续: "Remove invalid URLs and continue",
  电台源格式说明: "Source format guide",
  "文件和订阅接口均使用 UTF-8 编码的 JSON 数组。":
    "Files and source endpoints must provide a UTF-8 encoded JSON array.",
  "电台名称，必填；同一源内同名条目会合并备用线路。":
    "Required station name. Entries with the same name in a source are merged into one station with backup streams.",
  "可选的分类路径数组，例如国内电台 / 央广；一个电台可属于多个分类。":
    "Optional array of category paths, such as Domestic stations / China National Radio. A station can belong to multiple categories.",
  "必填的播放地址数组，按顺序尝试；支持字符串或包含 url、headers 的对象。":
    "Required array of stream URLs, tried in order. Each entry can be a string or an object containing url and headers.",
  "支持 HTTP(S)、HLS、FLV、RTMP(S)、RTSP(S)、MMS、MMST、MMSH；网页和接口地址先解析为媒体流，再通过服务器播放。":
    "Supports HTTP(S), HLS, FLV, RTMP(S), RTSP(S), MMS, MMST, and MMSH. Web page and API URLs are resolved to media streams, then played through the server.",
  "兼容地址后的 -headers 和 -reuse 参数；它们只作为配置解析，不会执行命令。请求头支持 User-Agent、Referer、Origin、Accept。":
    "URLs may include -headers and -reuse options. These are read as configuration and never executed as commands. Supported headers: User-Agent, Referer, Origin, and Accept.",
  "个人源需要服务端 FFmpeg；Docker 已包含，二进制部署可安装 FFmpeg 或设置 MEOW_FFMPEG。失效地址或需要授权的内容会报告错误。":
    "Personal sources require FFmpeg on the server. Docker includes it. For binary installations, install FFmpeg or set MEOW_FFMPEG. Unavailable URLs and content requiring authorization will report errors.",
  "下载示例 JSON": "Download example JSON",
  筛选个人电台: "Filter personal stations",
  "按来源和分类浏览，无需输入关键词。":
    "Browse by source and category without entering a search term.",
  电台来源: "Station source",
  全部来源: "All sources",
  分类: "Category",
  全部分类: "All categories",
  检查电台地址: "Check station URLs",
  "只列出检测失败的地址，确认后才会清理。":
    "Only URLs that fail the check are listed. They are removed only after you confirm.",
  "已检测 {{checked}} / {{total}} 个地址":
    "URLs checked: {{checked}} / {{total}}",
  停止检测: "Stop checking",
  全部选择: "Select all",
  "{{count}} 个地址检测失败": "URLs that failed the check: {{count}}",
  "{{count}} 个地址检测失败_one": "{{count}} URL failed the check",
  "{{count}} 个地址检测失败_other": "{{count}} URLs failed the check",
  "只清理选中的地址。仍有备用地址的电台及收藏会保留；没有地址的空电台及对应收藏会一并移除。":
    "Only selected URLs will be removed. Stations with remaining backup URLs and their favorites will be kept. Stations with no URLs left and their favorites will be removed.",
  "连接失败可能是暂时的，也可以先重新检测。":
    "Connection failures may be temporary. You can run the check again before removing URLs.",
  "所有地址均可用，没有需要清理的记录。":
    "All URLs passed the check. Nothing needs to be removed.",
  重新检测: "Check again",
  "正在清理…": "Removing…",
  "确认清理 {{count}} 个地址": "Confirm removal of {{count}} URLs",
  "确认清理 {{count}} 个地址_one": "Confirm removal of {{count}} URL",
  "确认清理 {{count}} 个地址_other": "Confirm removal of {{count}} URLs",
  系统电台: "System stations",
  个人电台: "Personal stations",
  个人源中匹配: "Matches in personal sources",
  登录后查看个人电台: "Sign in to view personal stations",
  没有匹配的个人电台: "No matching personal stations",
  "导入个人源，或调整搜索与分类筛选。":
    "Import a personal source, or adjust your search and category filters.",
  管理个人电台源: "Manage personal sources",
  个人源: "Personal sources",
  "个人源由服务器解析和播放。":
    "Personal sources are resolved and played through the server.",

  "名称为空、过长或包含控制字符":
    "The name is empty, too long, or contains control characters",
  请求头包含控制字符: "A request header contains control characters",
  "仅支持 User-Agent、Referer、Origin、Accept 请求头":
    "Only User-Agent, Referer, Origin, and Accept headers are supported",
  请求头值无效: "Invalid request header value",
  不支持的电台地址或地址包含凭据:
    "The station URL is unsupported or contains credentials",
  不允许访问本地或私有网络地址:
    "Local and private network addresses are not allowed",
  电台地址或参数无效: "Invalid station URL or options",
  "reuse 参数只允许 0 或 1": "The reuse option must be 0 or 1",
  "headers 参数需要引号": "The headers option must be quoted",
  "headers 参数引号不完整": "The headers option has an unclosed quote",
  请求头格式无效: "Invalid request header format",
  请求头重复: "Duplicate request header",
  参数格式无效: "Invalid option format",
  不支持的电台参数: "Unsupported station option",
  "订阅文件不能超过 5 MiB": "Source files must not exceed 5 MiB",
  "订阅 JSON 格式无效": "Invalid source JSON format",
  "每个订阅最多包含 5000 个电台":
    "Each source can contain up to 5,000 stations",
  "每个电台需要 1–16 个地址，最多 64 个分类路径":
    "Each station requires 1–16 URLs and can have up to 64 category paths",
  "分类路径需要 1–8 层": "Category paths must have 1–8 levels",
  合并同名电台后超出地址或分类数量限制:
    "Merging stations with the same name exceeds the URL or category limit",
  订阅包含无效播放地址: "The source contains invalid stream URLs",
  电台数据读取失败: "Could not read station data",
  私人订阅或电台不存在: "Personal source or station not found",
  "登录账号已变化，请刷新页面": "Your account has changed. Refresh the page.",
  "订阅地址未返回有效 JSON，已保留原有电台":
    "The source URL did not return valid JSON. Existing stations have been kept.",
  "订阅导入繁忙，请稍后重试": "Source imports are busy. Try again later.",
  "订阅上传超时，请重试": "Source upload timed out. Try again.",
  "文件订阅请上传新的 JSON 文件更新":
    "Upload a new JSON file to update this file source",
  "每个账号最多保存 32 个订阅": "Each account can save up to 32 sources",
  搜索条件过长: "Search criteria are too long",
  分类路径无效: "Invalid category path",
  分类数据读取失败: "Could not read category data",
  校验任务不存在或已过期: "The URL check was not found or has expired",
  私人订阅不存在: "Personal source not found",
  校验线路数量超过限制: "The number of stream URLs exceeds the check limit",
  "此订阅正在校验，请查看当前进度":
    "This source is already being checked. View its current progress.",
  "另一个订阅正在校验，请等待或取消":
    "Another source is being checked. Wait for it to finish or cancel it.",
  "校验任务较多，请稍后重试":
    "Too many URL checks are running. Try again later.",
  "服务端 FFmpeg 缺失或不支持此订阅所需协议，未判定任何线路失效":
    "FFmpeg is missing from the server or does not support a protocol this source requires. No stream URLs have been marked as failed.",
  "线路校验超时，可能暂时不可用，建议稍后重试":
    "The stream URL check timed out. It may be temporarily unavailable. Try again later.",
  "播放资源已变化，校验已取消":
    "The media resource changed. The check was cancelled.",
  "服务端校验组件不可用，请修复后重新校验":
    "The server's checking component is unavailable. Fix it before checking again.",
  清理线路数量或标识无效:
    "Invalid number of stream URLs or invalid identifiers selected for removal",
  "校验未完成或结果已更新，请重新校验":
    "The check is incomplete or its results have changed. Run the check again.",
  只能清理本次校验中确认失效的线路:
    "Only stream URLs that failed this check can be removed",
  电台地址解析出现循环: "A loop was detected while resolving the station URL",
  电台响应不是可识别的音频或页面:
    "The station response is not recognized as audio or a web page",
  "页面未提供可用音频地址，可能需要登录、脚本执行或源已失效":
    "The page did not provide a usable audio URL. It may require sign-in or JavaScript, or the source may be unavailable.",
  电台地址解析层数过多: "Too many steps required to resolve the station URL",
  音频请求头不受支持: "Unsupported audio request header",
  音频请求头过长: "Audio request header is too long",
  音频请求头无效: "Invalid audio request header",
  电台地址协议或主机无效: "Invalid station URL protocol or host",
  电台响应超过大小限制: "The station response exceeds the size limit",
  "转码任务较多，请稍后重试":
    "Too many transcoding jobs are running. Try again later.",
  最多同时播放两个个人电台: "You can play up to two personal stations at once",
  无效的播放线路: "Invalid stream selection",
  "服务端需要安装支持 libmp3lame 的 FFmpeg":
    "The server requires FFmpeg with libmp3lame support",
  "所有播放线路均不可用，请检查地址或稍后重试":
    "All streams are unavailable. Check the URLs or try again later.",
  "播放线路连接超时，请稍后重试":
    "The stream connection timed out. Try again later.",
  "服务端未启用媒体中转，无法验证播放地址":
    "Media relay is disabled on the server, so stream URLs cannot be checked",
  播放地址验证已取消: "The stream URL check was cancelled",
  播放地址验证超时: "The stream URL check timed out",
  "FFmpeg 缺少所需的原生 RTMP 协议支持":
    "FFmpeg lacks the required native RTMP protocol support",
  "FFmpeg 缺少所需的 RTSP 支持": "FFmpeg lacks the required RTSP support",
  "FFmpeg 缺少所需的 MMST 协议支持":
    "FFmpeg lacks the required MMST protocol support",
  "FFmpeg 缺少所需的 MMSH 协议支持":
    "FFmpeg lacks the required MMSH protocol support",
  "FFmpeg 缺少完整的 MMS（MMST/MMSH）协议支持":
    "FFmpeg lacks full MMS (MMST/MMSH) protocol support",
  播放地址连接超时: "The stream URL connection timed out",
  无法识别此音频格式: "Unrecognized audio format",
  "无法启动 FFmpeg 转码程序": "Could not start FFmpeg for transcoding",
  "FFmpeg 缺少此媒体所需的解码器、格式或协议支持":
    "FFmpeg lacks the decoder, format, or protocol support required for this media",
  "不支持 HLS 变量": "HLS variables are not supported",
  无效媒体资源地址: "Invalid media resource URL",
  媒体重定向次数过多: "Too many media redirects",
  媒体资源已失效: "The media resource is no longer available",
  "无效 HLS 播放列表": "Invalid HLS playlist",
  "无效 HLS 属性": "Invalid HLS attribute",
  传输不支持自定义请求头:
    "This transport does not support custom request headers",
  不支持的媒体请求头: "Unsupported media request header",
  "媒体资源必须使用 HTTP 或 HTTPS": "Media resources must use HTTP or HTTPS",
  媒体地址不能包含账号密码:
    "Media URLs must not contain a username or password",
  不支持此媒体协议: "This media protocol is not supported",
  媒体地址缺少主机名: "The media URL is missing a hostname",
  媒体端口不在支持范围内: "The media port is outside the supported range",
  媒体仅允许公共互联网地址:
    "Only public internet addresses are allowed for media",
};

export default sourcesEnglish;
