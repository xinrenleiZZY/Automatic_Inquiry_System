# ===========================================================================
# 自动询价系统 · 容器应用层（前端 + API）
#
# 为什么是一个容器：前端由 FastAPI 同源托管，cookie / SSO 天然可用，
# 不需要额外的 Nginx，也避免 CORS 配置。
#
# Chrome、monitor、Node bridge 和 im.db 由 Windows 宿主控制代理负责；
# 运行时镜像不需要 Node。
# ===========================================================================

ARG NODE_BASE=node:22-bookworm-slim
ARG PYTHON_BASE=python:3.12-slim

# ---------- 1. 构建前端 ----------
FROM ${NODE_BASE} AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- 2. 运行镜像 ----------
FROM ${PYTHON_BASE}
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1
ENV TZ=Asia/Shanghai

WORKDIR /app
COPY backend/requirements.txt ./requirements.txt
RUN pip install -r requirements.txt

COPY backend/ ./backend/
COPY --from=web /web/dist ./frontend/dist

ENV PROJECT_ROOT=/app/project
ENV QIANNIU_DIR=/app/project/tools/qianniu
ENV IM_DB=/app/data/im.snapshot.db
ENV PHRASE_LIB=/app/project/tools/qianniu/phrase-library.json
ENV IMAGE_DIR=/app/project/tools/qianniu/image
ENV API_DB=/app/data/api.db
ENV FRONTEND_DIST=/app/frontend/dist
ENV APP_HOST=0.0.0.0
ENV APP_PORT=6900

EXPOSE 6900
WORKDIR /app/backend
HEALTHCHECK --interval=30s --timeout=10s --retries=3 CMD ["python", "healthcheck.py"]

CMD ["sh", "-c", "python -m uvicorn main:app --host 0.0.0.0 --port ${APP_PORT:-6900}"]
