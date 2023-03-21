# Whisper 生成影片字幕

## 安裝

首先先複製出 `.env`，並貼上 OpenAI 的 Key 到 `OPENAI_API_KEY`。

需要安裝 Node.js、ffmpeg (包含 ffprobe 執行檔)，然後安裝依賴：

```
npm i
```

## 使用

拖曳影片至 `subtitle.cmd`。

或使用命令行模式：

```
node subtitle.js video.mp4
```
