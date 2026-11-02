#!/usr/bin/env python3
"""
Upload App Store Connect metadata + screenshots via REST API.
Uses the .p8 private key directly — no Ruby/fastlane dependency.
"""

import jwt
import time
import json
import sys
import os
import requests
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────
KEY_ID     = "26664ZL92N"
ISSUER_ID  = "69a6de88-27f1-47e3-e053-5b8c7c11a4d1"
KEY_PATH   = Path.home() / ".appstoreconnect/private_keys/AuthKey_26664ZL92N.p8"
BUNDLE_ID  = "bio.nodes.cue"
BASE_URL   = "https://api.appstoreconnect.apple.com/v1"

METADATA = {
    "name":        "Cue — AR Teleprompter",
    "subtitle":    "Speak freely. Read anywhere.",
    "description": """Cue is a teleprompter built for the real world.

Scroll your script directly on your AR glasses — no podium, no notes, no looking down. Just you and your words, delivered with confidence.

FEATURES
• Stream your script live to Even Realities G1 AR glasses
• Control playback speed from slow to fast
• Full-screen teleprompter mode on iPhone
• Create and manage multiple scripts
• Import scripts or paste from clipboard
• Works without a connection — controls still work offline

PERFECT FOR
• Keynotes and conference talks
• Product demos and pitches
• Video recordings and podcasts
• Wedding speeches and toasts
• Anyone who needs their words in front of them

Cue keeps your eyes up and your delivery natural.""",
    "keywords":    "teleprompter,AR glasses,autocue,speech,presenter,keynote,prompter,script,G1,Even Realities",
    "supportUrl":  "https://nodes.bio",
    "marketingUrl":"https://nodes.bio",
}

SCREENSHOTS_DIR = Path(__file__).parent.parent / "fastlane/screenshots/en-US/iPhone 6.7\" Display"

# ── JWT ───────────────────────────────────────────────────────────────────────
def make_token():
    private_key = KEY_PATH.read_text()
    payload = {
        "iss": ISSUER_ID,
        "iat": int(time.time()),
        "exp": int(time.time()) + 1200,
        "aud": "appstoreconnect-v1",
    }
    return jwt.encode(payload, private_key, algorithm="ES256", headers={"kid": KEY_ID})

def headers():
    return {"Authorization": f"Bearer {make_token()}", "Content-Type": "application/json"}

# ── Helpers ───────────────────────────────────────────────────────────────────
def get(path, **kwargs):
    r = requests.get(f"{BASE_URL}{path}", headers=headers(), **kwargs)
    r.raise_for_status()
    return r.json()

def post(path, body):
    r = requests.post(f"{BASE_URL}{path}", headers=headers(), json=body)
    r.raise_for_status()
    return r.json()

def patch(path, body):
    r = requests.patch(f"{BASE_URL}{path}", headers=headers(), json=body)
    r.raise_for_status()
    return r.json()

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print("🔑 Authenticating with App Store Connect...")

    # 1. Find the app
    apps = get(f"/apps?filter[bundleId]={BUNDLE_ID}")
    if not apps["data"]:
        print(f"❌ No app found with bundle ID {BUNDLE_ID}")
        sys.exit(1)
    app = apps["data"][0]
    app_id = app["id"]
    print(f"✅ Found app: {app['attributes']['name']} ({app_id})")

    # 2. Find the editable app store version (PREPARE_FOR_SUBMISSION or DEVELOPER_REJECTED)
    versions = get(f"/apps/{app_id}/appStoreVersions?filter[platform]=IOS&filter[appStoreState]=PREPARE_FOR_SUBMISSION,DEVELOPER_REJECTED,READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,PENDING_DEVELOPER_RELEASE")
    if not versions["data"]:
        # Try getting any version
        versions = get(f"/apps/{app_id}/appStoreVersions?filter[platform]=IOS")
    
    if not versions["data"]:
        print("❌ No editable App Store version found.")
        sys.exit(1)

    version = versions["data"][0]
    version_id = version["id"]
    version_str = version["attributes"]["versionString"]
    state = version["attributes"]["appStoreState"]
    print(f"✅ Found version {version_str} (state: {state}, id: {version_id})")

    # 3. Get or find the en-US localisation
    locs = get(f"/appStoreVersions/{version_id}/appStoreVersionLocalizations")
    en_loc = next((l for l in locs["data"] if l["attributes"]["locale"] == "en-US"), None)

    if not en_loc:
        print("Creating en-US localisation...")
        en_loc = post("/appStoreVersionLocalizations", {
            "data": {
                "type": "appStoreVersionLocalizations",
                "attributes": {"locale": "en-US"},
                "relationships": {
                    "appStoreVersion": {"data": {"type": "appStoreVersions", "id": version_id}}
                }
            }
        })["data"]

    loc_id = en_loc["id"]
    print(f"✅ Localisation ID: {loc_id}")

    # 4. Update metadata
    print("📝 Uploading metadata...")
    patch(f"/appStoreVersionLocalizations/{loc_id}", {
        "data": {
            "type": "appStoreVersionLocalizations",
            "id": loc_id,
            "attributes": {
                "description":  METADATA["description"],
                "keywords":     METADATA["keywords"],
                "supportUrl":   METADATA["supportUrl"],
                "marketingUrl": METADATA["marketingUrl"],
            }
        }
    })
    print("✅ Metadata updated")

    # 5. Update app name/subtitle (app-level, not version-level)
    app_infos = get(f"/apps/{app_id}/appInfos")
    if app_infos["data"]:
        app_info_id = app_infos["data"][0]["id"]
        app_info_locs = get(f"/appInfos/{app_info_id}/appInfoLocalizations")
        en_info_loc = next((l for l in app_info_locs["data"] if l["attributes"]["locale"] == "en-US"), None)
        if en_info_loc:
            patch(f"/appInfoLocalizations/{en_info_loc['id']}", {
                "data": {
                    "type": "appInfoLocalizations",
                    "id": en_info_loc["id"],
                    "attributes": {
                        "name":     METADATA["name"],
                        "subtitle": METADATA["subtitle"],
                    }
                }
            })
            print("✅ App name/subtitle updated")

    # 6. Upload screenshots
    if SCREENSHOTS_DIR.exists():
        print(f"\n📸 Uploading screenshots from {SCREENSHOTS_DIR}...")

        # Delete existing screenshots for this localisation
        existing = get(f"/appStoreVersionLocalizations/{loc_id}/appScreenshotSets")
        for ss_set in existing["data"]:
            # Get screenshots in each set and delete them
            set_id = ss_set["id"]
            screenshots = get(f"/appScreenshotSets/{set_id}/appScreenshots")
            for ss in screenshots["data"]:
                requests.delete(f"{BASE_URL}/appScreenshots/{ss['id']}", headers=headers())
        
        png_files = sorted(SCREENSHOTS_DIR.glob("*.png"))
        print(f"   Found {len(png_files)} screenshots")

        # Get or create screenshot set for iPhone 6.5" (which covers 6.7" slot too)
        # display_type for iPhone 15 Pro Max / 16 Pro Max = APP_IPHONE_67
        display_type = "APP_IPHONE_67"
        
        ss_sets = get(f"/appStoreVersionLocalizations/{loc_id}/appScreenshotSets")
        ss_set = next((s for s in ss_sets["data"] if s["attributes"]["screenshotDisplayType"] == display_type), None)

        if not ss_set:
            print(f"   Creating screenshot set ({display_type})...")
            ss_set = post("/appScreenshotSets", {
                "data": {
                    "type": "appScreenshotSets",
                    "attributes": {"screenshotDisplayType": display_type},
                    "relationships": {
                        "appStoreVersionLocalization": {
                            "data": {"type": "appStoreVersionLocalizations", "id": loc_id}
                        }
                    }
                }
            })["data"]

        ss_set_id = ss_set["id"]

        for i, png in enumerate(png_files):
            file_size = png.stat().st_size
            print(f"   Uploading {png.name} ({file_size} bytes)...")

            # Reserve upload
            reservation = post("/appScreenshots", {
                "data": {
                    "type": "appScreenshots",
                    "attributes": {
                        "fileName": png.name,
                        "fileSize": file_size,
                    },
                    "relationships": {
                        "appScreenshotSet": {
                            "data": {"type": "appScreenshotSets", "id": ss_set_id}
                        }
                    }
                }
            })

            ss_id = reservation["data"]["id"]
            upload_ops = reservation["data"]["attributes"]["uploadOperations"]

            # Upload the file parts
            file_bytes = png.read_bytes()
            for op in upload_ops:
                offset = op["offset"]
                length = op["length"]
                chunk  = file_bytes[offset:offset+length]
                op_headers = {h["name"]: h["value"] for h in op["requestHeaders"]}
                r = requests.put(op["url"], headers=op_headers, data=chunk)
                r.raise_for_status()

            # Commit
            patch(f"/appScreenshots/{ss_id}", {
                "data": {
                    "type": "appScreenshots",
                    "id": ss_id,
                    "attributes": {"uploaded": True, "sourceFileChecksum": None}
                }
            })
            print(f"   ✅ {png.name} uploaded")

    print("\n🎉 Done! Metadata and screenshots uploaded to App Store Connect.")
    print("   Go to https://appstoreconnect.apple.com to review before submitting.")

if __name__ == "__main__":
    main()
