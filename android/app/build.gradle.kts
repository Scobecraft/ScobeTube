import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Version: aus Umgebungsvariable (CI, Git-Tag) oder version.properties
val versionProps = Properties().apply { rootProject.file("version.properties").inputStream().use { load(it) } }
val appVersionName: String = (System.getenv("APP_VERSION_NAME") ?: versionProps.getProperty("VERSION_NAME")).trim()
// versionCode = MAJOR*10000 + MINOR*100 + PATCH  (z. B. 1.2.3 → 10203) – identisch mit der Server-Logik
val appVersionCode: Int = appVersionName.split(".").map { it.filter(Char::isDigit).ifEmpty { "0" }.toInt() }
    .let { (it.getOrElse(0) { 0 } * 10000) + (it.getOrElse(1) { 0 } * 100) + it.getOrElse(2) { 0 } }

android {
    namespace = "de.scobecraft.scobetube"
    compileSdk = 35

    defaultConfig {
        applicationId = "de.scobecraft.scobetube"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName
        buildConfigField("String", "DEFAULT_SERVER", "\"https://convert.scobecraft.pro\"")
    }

    // Signatur aus Umgebungsvariablen (GitHub-Secrets) – gleiche Signatur = Updates möglich
    val ksFile = System.getenv("SCOBETUBE_KEYSTORE")
    signingConfigs {
        if (ksFile != null) {
            create("release") {
                storeFile = file(ksFile)
                storePassword = System.getenv("SCOBETUBE_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("SCOBETUBE_KEY_ALIAS") ?: "scobetube"
                keyPassword = System.getenv("SCOBETUBE_KEY_PASSWORD") ?: System.getenv("SCOBETUBE_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (ksFile != null) signingConfig = signingConfigs.getByName("release")
        }
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
