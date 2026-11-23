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
        versionCode = 2
        versionName = "2.0"
    }

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
