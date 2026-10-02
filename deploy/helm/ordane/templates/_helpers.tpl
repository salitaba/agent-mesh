{{/* The chart's name, truncated to the 63 characters a DNS label allows. */}}
{{- define "ordane.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* A release-unique name for the objects of this instance. */}}
{{- define "ordane.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "ordane.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "ordane.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ordane.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "ordane.labels" -}}
helm.sh/chart: {{ include "ordane.chart" . }}
{{ include "ordane.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "ordane.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "ordane.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* The credentials Secret is required: an instance with no token must not be installable. */}}
{{- define "ordane.secretName" -}}
{{- required "auth.existingSecret is required: create a Secret that holds MESH_API_TOKEN (and ANTHROPIC_API_KEY) and name it here" .Values.auth.existingSecret }}
{{- end }}
