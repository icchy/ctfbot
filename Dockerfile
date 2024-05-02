FROM denoland/deno:latest

COPY . /src/
WORKDIR /src/

RUN deno cache main.ts

CMD ["deno", "run", "--unstable", "--allow-read", "--allow-write", "--allow-env", "--allow-net", "main.ts"]
