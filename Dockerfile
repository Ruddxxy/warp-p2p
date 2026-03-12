# Build stage
FROM golang:1.25-alpine AS builder

WORKDIR /app

# Install certificates for HTTPS
RUN apk --no-cache add ca-certificates

# Copy go mod files from server directory
COPY server/go.mod server/go.sum ./
RUN go mod download

# Copy source from server directory
COPY server/*.go ./

# Build static binary
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-w -s" -o signaling-server .

# Create non-root user
RUN addgroup -g 10001 -S app && adduser -u 10001 -S app -G app

# Production stage - scratch for minimal image
FROM scratch

# Copy passwd for non-root user
COPY --from=builder /etc/passwd /etc/passwd

# Copy certificates
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# Copy binary
COPY --from=builder /app/signaling-server /signaling-server

# Run as non-root
USER app

# Expose port (hosting platform sets PORT env var)
EXPOSE 8080

ENTRYPOINT ["/signaling-server"]
