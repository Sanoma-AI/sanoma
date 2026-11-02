# Standalone trusted identity service. Install an exact published launcher release;
# this image never clones or loads a company repository.
FROM node:26-bookworm-slim
ARG SANOMA_VERSION
RUN node -e 'if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(process.argv[1])) process.exit(1)' "$SANOMA_VERSION" \
 && npm install --global --omit=dev --ignore-scripts "sanoma@$SANOMA_VERSION" \
 && npm cache clean --force
ENV PORT=8080 SANOMA_IDENTITY_HOST=0.0.0.0
USER node
WORKDIR /home/node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["sanoma", "identity"]
