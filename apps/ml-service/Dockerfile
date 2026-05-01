FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app

COPY pyproject.toml README.md ./
COPY lumo_ml ./lumo_ml
COPY app ./app

RUN pip install --no-cache-dir .
RUN python -m spacy download en_core_web_sm

EXPOSE 8080

CMD ["sh", "-c", "uvicorn lumo_ml.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
