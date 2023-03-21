# Whisper 生成影片字幕

拖曳影片就可以生成字幕

## 安裝

首先先複製出 `.env`，並貼上 OpenAI 的 Key 到 `OPENAI_API_KEY`。

需要安裝 Node.js、ffmpeg (包含 ffprobe 執行檔)，然後安裝依賴：

```
npm i
```

## 使用

拖曳影片至 `subtitle.cmd`，過一會兒就可以看到和影片同名的 `.srt` 字幕出現了。

也可以在任意地方建立 `subtitle.cmd` 的捷徑，這樣就更方便了！

> **Warning**: 如果出現閃退，有可能是路徑中包含中文或路徑太長，確保路徑中不要出現中文。

或使用命令行模式：

```
node subtitle.js video.mp4
```
