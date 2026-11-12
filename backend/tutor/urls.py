from django.urls import path
from .views import TutorAskView, TutorContextView, TutorStatusView
urlpatterns = [path('status/', TutorStatusView.as_view(), name='tutor-status'), path("ask/", TutorAskView.as_view(), name="tutor-ask"), path('context/', TutorContextView.as_view(), name='tutor-context')]
