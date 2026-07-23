FROM python:3.12-slim

WORKDIR /app

# Dependencias del sistema mínimas
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

EXPOSE 9000

# --proxy-headers + --forwarded-allow-ips: sin esto uvicorn ignora el
# X-Forwarded-Proto de Nginx (llega desde la IP del bridge Docker, no 127.0.0.1)
# y los redirects de FastAPI salen como http://, que el navegador bloquea por
# mixed content. Solo es seguro con el puerto publicado en loopback.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "9000", "--proxy-headers", "--forwarded-allow-ips", "*"]
