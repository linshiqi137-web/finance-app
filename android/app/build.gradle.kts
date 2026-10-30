plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val bundlePwa by tasks.registering(Sync::class) {
    from(rootProject.layout.projectDirectory.dir("..")) {
        include("index.html", "styles.css", "icon.svg", "manifest.webmanifest", "js/**")
    }
    into(layout.buildDirectory.dir("generated/pwaAssets"))
}

android {
    namespace = "com.xiaonagi.jizhang"
    compileSdk = 35
    buildToolsVersion = "35.0.0"
    defaultConfig {
        applicationId = "com.xiaonagi.jizhang"
        minSdk = 26
        targetSdk = 35
        versionCode = 4
        versionName = "0.4.0"
    }
    sourceSets["main"].assets.srcDir(bundlePwa.map { it.destinationDir })
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
tasks.named("preBuild") { dependsOn(bundlePwa) }

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    testImplementation("junit:junit:4.13.2")
}
