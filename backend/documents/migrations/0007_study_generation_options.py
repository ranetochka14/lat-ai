from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('documents', '0006_study_pilot')]
    operations = [migrations.AddField(
        model_name='studypack', name='generation_options',
        field=models.JSONField(default=dict),
    )]
