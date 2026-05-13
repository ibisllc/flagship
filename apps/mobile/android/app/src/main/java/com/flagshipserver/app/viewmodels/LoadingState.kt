// Kotlin mirror of FlagshipUI/ViewModels/LoadingState.swift.
// Three-arm sum type that every screen-level VM exposes for its primary
// fetch. Compose collectAsState makes the transition lifecycle-aware.

package com.flagshipserver.app.viewmodels

sealed interface LoadingState<out T> {
    data object Idle : LoadingState<Nothing>
    data object Loading : LoadingState<Nothing>
    data class Loaded<T>(val value: T) : LoadingState<T>
    data class Failed(val message: String) : LoadingState<Nothing>
}
