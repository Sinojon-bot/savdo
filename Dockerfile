FROM node:22-bookworm-slim
WORKDIR /app
COPY server.mjs i18n.mjs app.js index.html download.html invite.html phone.html sw.js manifest.webmanifest package.json* ./
COPY icons ./icons
RUN mkdir -p data
ENV PORT=4173
EXPOSE 4173
CMD ["node", "server.mjs"]
