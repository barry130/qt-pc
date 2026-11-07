# Playback speed fixture

`playback-speed-mono-32k.m4a` is a self-generated 10-second 523.25 Hz sine
wave, encoded as AAC with one channel at 32 kHz. It contains no downloaded
audio. The regression test decodes it through the production source wrappers
after a 44.1 kHz stereo source and checks content time against device frames.

Generated with FFmpeg 5.1.2:

```sh
ffmpeg -f lavfi -i 'sine=frequency=523.25:sample_rate=32000:duration=10' \
  -ac 1 -c:a aac -b:a 24k -map_metadata -1 -movflags +faststart \
  playback-speed-mono-32k.m4a
```
