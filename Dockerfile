FROM python:3.12-slim

WORKDIR /app

# Copy dependency manifest first so Docker can cache the install layer.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the project.
COPY . .

EXPOSE 8000

CMD ["uvicorn", "runner.main:app", "--host", "0.0.0.0", "--port", "8000"]
