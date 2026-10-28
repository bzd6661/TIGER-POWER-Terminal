# TIGER POWER 公开只读版(服务器部署用)。构建目录是仓库根目录:docker compose -f deploy/docker-compose.yml up -d --build
#   镜像里只放只读数据服务需要的文件(见仓库根目录 .dockerignore 白名单):没有 baw、没有下单脚本、没有任何钱包文件
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    TRUST_PROXY=1 \
    AGENTBUY_DATA_DIR=/data \
    AGENTBUY_NO_UPDATE_CHECK=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY . .
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--max-old-space-size=1536", "panel/public-server.mjs"]
