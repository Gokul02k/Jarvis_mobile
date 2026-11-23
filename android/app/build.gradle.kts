plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.jarvis.mobile"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.jarvis.mobile"
        minSdk = 26
        targetSdk = 35
        // CI builds count up (100 + run number) so each one installs as an update over the last.
        // No user-facing version number yet: builds are just "build N".
        val run = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull()
        versionCode = if (run != null) 100 + run else 1
        versionName = if (run != null) "build $run" else "dev build"
        buildConfigField("String", "GIT_SHA", "\"${System.getenv("GITHUB_SHA")?.take(7) ?: "dev"}\"")
    }

    buildFeatures { buildConfig = true }

    // A fixed key so new builds install as updates over old ones (sideloading only).
    signingConfigs {
        create("sideload") {
            storeFile = file("jarvis-sideload.keystore")
            storePassword = "jarvis123"
            keyAlias = "jarvis"
            keyPassword = "jarvis123"
        }
    }

    buildTypes {
        debug { signingConfig = signingConfigs.getByName("sideload") }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("sideload")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    // The whole Jarvis web app (../../web) is bundled as the app's assets: one codebase for web + Android.
    sourceSets {
        getByName("main") { assets.srcDirs("../../web") }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.webkit:webkit:1.12.1")
}
