FROM python:3.12-alpine
RUN apk add --no-cache docker-cli curl openssl
WORKDIR /app
COPY farm.py vendors.py locations.json ui.html /app/
COPY catalogs /app/catalogs
COPY flags /app/flags
LABEL proxy-farm=manager
ENTRYPOINT ["python3", "farm.py", "serve"]
