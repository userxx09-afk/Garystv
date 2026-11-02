plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The screens come from src/ui; `npm run firetv` copies them into src/main/assets/www first.
val screens = file("src/main/assets/www/index.html")

android {
    namespace = "local.garystv"
    compileSdk = 35

    defaultConfig {
        applicationId = "local.garystv"
        // Fire OS 6 (Android 7.1) and newer: their Chromium WebView plays the live TV streams (MSE).
        minSdk = 25
        targetSdk = 35
        versionCode = System.getenv("GTV_VERSION_CODE")?.toInt() ?: 1
        versionName = System.getenv("GTV_VERSION_NAME") ?: "0.1.0"
    }

    // Android only installs an update over the old app when both are signed with the same key,
    // so CI signs with GarysTV's own key (GTV_KEYSTORE, from the repo's secrets). Without it the
    // build falls back to this machine's debug key, and that APK won't update a CI-built one.
    val keystore = System.getenv("GTV_KEYSTORE")?.let { file(it) }?.takeIf { it.exists() }
    signingConfigs {
        if (keystore != null) create("garystv") {
            storeFile = keystore
            storePassword = System.getenv("GTV_KEYSTORE_PASSWORD")
            keyAlias = "garystv"
            keyPassword = System.getenv("GTV_KEYSTORE_PASSWORD")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("garystv") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

tasks.named("preBuild") {
    doFirst {
        if (!screens.exists()) throw GradleException("Run `npm run firetv` in the GarysTV folder first (it copies the screens into the app).")
    }
}
