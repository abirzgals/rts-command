# RTS Command

A browser-based real-time strategy game built with Three.js, bitECS, and Vite.

## Quick Start

```bash
npm install
npm run dev
```

## Build & Serve

```bash
npm run build
npm run serve
```

## Docker

```bash
docker build -t rts-command .
docker run -p 80:80 rts-command
```

## Harbor Registry

Image is published to:

```
harbor.artplace.cc/rts-command
```

### Push to Harbor

```bash
docker login harbor.artplace.cc
docker build -t harbor.artplace.cc/rts-command:latest .
docker push harbor.artplace.cc/rts-command:latest
```
