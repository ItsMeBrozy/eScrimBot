import os
import sys

# Force Hugging Face libraries to fall back to standard requests and use the OS truststore.
os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "0")

try:
    import pip_system_certs
    pip_system_certs.inject_into_requests()
    print("[INFO] Using OS certificate store via pip-system-certs.")
except Exception as e:
    print(f"[WARN] pip-system-certs unavailable or failed: {e}", file=sys.stderr)

try:
    import truststore
    print("[INFO] truststore package is installed.")
except Exception:
    pass

try:
    print("[INFO] Initializing Hugging Face client connection...")
    # Your anti gravity / huggingface code goes here
    # Example: client = InferenceClient(...)
    
except Exception as e:
    print(f"[ERROR] Connection or initialization failed in the Space environment: {e}", file=sys.stderr)
    print("[DIAGNOSTIC] Check if requirements.txt includes 'pip-system-certs', 'truststore', and that HF_HUB_ENABLE_HF_TRANSFER=0 is set.", file=sys.stderr)
