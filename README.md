# Whisper 影片字幕生成工具

在 Windows 拖曳影片就可以生成字幕

## 安裝

首先先複製出 `.env`，並貼上 OpenAI 的 Key 到 `OPENAI_API_KEY`。

需要安裝 Node.js、ffmpeg (包含 ffprobe 執行檔)，然後安裝依賴：

```bash
npm install
```

## 使用

首先先在任意地方建立 `subtitle.cmd` 的捷徑，命名為「生成字幕」，然後將影片拖曳上去，過一會兒就可以看到和影片同名的 `.srt` 字幕出現了。

或使用命令行模式：

```bash
node subtitle.js video.mp4
```

如果要增加 prompt 的話，可以建立一個 `prompt.txt` 檔案，將內容輸入裡面，就會自動將提示文字發送給 Whisper 了。

## 輸出格式

輸出格式可以選擇 `srt` 和 `txt`：

```bash
node subtitle.js video.mp4 --format srt
node subtitle.js video.mp4 --format txt
node subtitle.js video.mp4 --format srt,txt
```

### srt 轉 txt

先在任意地方建立 `srt-to-txt.cmd` 的捷徑，命名為「srt 轉 txt」，然後將 `.srt` 字幕檔拖曳上去就好了。
