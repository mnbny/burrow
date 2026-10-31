FROM node:22-alpine
LABEL org.opencontainers.image.source=https://github.com/mnbny/burrow
COPY server/server.bundle.mjs /server.mjs
# The server starts as root, chowns the data dir, and drops to the node user
# itself, so volumes from older root images need no manual migration.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080
CMD ["node", "/server.mjs"]
